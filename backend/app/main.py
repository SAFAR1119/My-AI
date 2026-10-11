
import logging
import os
import asyncio
from typing import Any
from urllib.parse import urlparse

from fastapi import WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors, types
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

APP_NAME = os.getenv("APP_NAME", "My AI Voice")
FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "http://localhost:3000",
)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")

client = (
    genai.Client(api_key=GEMINI_API_KEY)
    if GEMINI_API_KEY
    else None
)

app = FastAPI(
    title=APP_NAME,
    version="0.3.0",
    description="Personal AI voice and text assistant with web search.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class Message(BaseModel):
    role: str
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=30)


class Source(BaseModel):
    title: str
    url: str


class ChatResponse(BaseModel):
    reply: str
    mode: str
    sources: list[Source] = Field(default_factory=list)


def read_field(obj: Any, name: str) -> Any:
    """Read a field from either a dictionary or an SDK object."""
    if isinstance(obj, dict):
        return obj.get(name)

    return getattr(obj, name, None)


def extract_sources(response: Any) -> list[Source]:
    """Extract unique web sources returned by Google Search grounding."""
    sources: list[Source] = []
    seen_urls: set[str] = set()

    candidates = read_field(response, "candidates") or []

    for candidate in candidates:
        metadata = read_field(candidate, "grounding_metadata")

        if metadata is None:
            metadata = read_field(candidate, "groundingMetadata")

        if metadata is None:
            continue

        chunks = read_field(metadata, "grounding_chunks")

        if chunks is None:
            chunks = read_field(metadata, "groundingChunks")

        for chunk in chunks or []:
            web = read_field(chunk, "web")

            if web is None:
                continue

            url = read_field(web, "uri") or read_field(web, "url")
            title = read_field(web, "title")

            if not isinstance(url, str):
                continue

            parsed_url = urlparse(url)

            if parsed_url.scheme != "https" or not parsed_url.netloc:
                continue

            if url in seen_urls:
                continue

            seen_urls.add(url)
            sources.append(
                Source(
                    title=title.strip() if isinstance(title, str) and title.strip() else parsed_url.netloc,
                    url=url,
                )
            )

            if len(sources) >= 8:
                return sources

    return sources


@app.get("/")
async def root():
    return {
        "name": APP_NAME,
        "status": "running",
        "docs": "/docs",
    }


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "ai_configured": client is not None,
        "provider": "Gemini" if client else None,
        "model": GEMINI_MODEL if client else None,
        "web_search_enabled": client is not None,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    allowed_roles = {"user", "assistant"}

    if any(
        message.role not in allowed_roles
        for message in request.messages
    ):
        raise HTTPException(
            status_code=422,
            detail="Messages may only have user or assistant roles.",
        )

    if request.messages[-1].role != "user":
        raise HTTPException(
            status_code=422,
            detail="The latest message must be from the user.",
        )

    if client is None:
        return ChatResponse(
            reply=(
                "I'm running in demo mode. Add a Gemini API key "
                "to enable real AI responses."
            ),
            mode="demo",
        )

    contents = [
        {
            "role": "model" if message.role == "assistant" else "user",
            "parts": [{"text": message.content}],
        }
        for message in request.messages
    ]

    try:
        response = await client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=(
                    "You are a friendly personal AI voice assistant. "
                    "Answer naturally, accurately, and clearly. "
                    "Prefer concise responses that sound good aloud. "
                    "For recent events, current information, prices, "
                    "or facts that may have changed, use Google Search "
                    "when it will help you answer accurately. "
                    "Do not claim to have searched the web unless you "
                    "actually used search results. Be transparent when "
                    "current information cannot be verified."
                ),
                tools=[
                    types.Tool(
                        google_search=types.GoogleSearch()
                    )
                ],
            ),
        )

        reply = (response.text or "").strip()

        if not reply:
            raise HTTPException(
                status_code=502,
                detail="The AI provider returned an empty response.",
            )

        sources = extract_sources(response)

        logger.info(
            "Gemini response received; extracted %d source(s).",
            len(sources),
        )

        return ChatResponse(
            reply=reply,
            mode="ai",
            sources=sources,
        )

    except HTTPException:
        raise

    except errors.APIError as exc:
        logger.warning(
            "Gemini API error: code=%s, message=%s",
            exc.code,
            exc.message,
        )

        if exc.code == 503:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Gemini is temporarily overloaded. "
                    "Wait 10–30 seconds and try again."
                ),
            ) from exc

        if exc.code == 429:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini has reached a usage limit. "
                    "Check your API quota and try again later."
                ),
            ) from exc

        if exc.code == 404:
            raise HTTPException(
                status_code=502,
                detail=(
                    "The configured Gemini model or requested capability "
                    "is unavailable. Check the model and API access."
                ),
            ) from exc

        raise HTTPException(
            status_code=502,
            detail=(
                f"Gemini returned API error {exc.code}. "
                "Check the backend terminal for details."
            ),
        ) from exc

    except Exception as exc:
        logger.exception("Unexpected Gemini request failure")

        raise HTTPException(
            status_code=502,
            detail="An unexpected error occurred while contacting Gemini.",
        ) from exc


@app.websocket("/api/live")
async def live_voice(websocket: WebSocket):
    await websocket.accept()

    if client is None:
        await websocket.send_json({
            "type": "error",
            "message": "Gemini API key is not configured.",
        })
        await websocket.close(code=1011)
        return

    live_model = os.getenv(
        "GEMINI_LIVE_MODEL",
        "gemini-3.8-live",
    ).strip()

    try:
        config = {
            "response_modalities": ["AUDIO"],
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "speech_config": {
                "voice_config": {
                    "prebuilt_voice_config": {
                        "voice_name": "Kore",
                    }
                }
            },
            "system_instruction": (
                "You are a friendly, helpful personal AI voice assistant. "
                "Speak naturally and conversationally. Keep answers clear "
                "and reasonably concise. Listen to the user and respond "
                "to the meaning of what they say."
            ),
        }

        async with client.aio.live.connect(
            model=live_model,
            config=config,
        ) as session:
            await websocket.send_json({
                "type": "ready",
                "model": live_model,
                "message": "Live voice connected.",
            })

            async def send_microphone_audio():
                while True:
                    packet = await websocket.receive()

                    if packet["type"] == "websocket.disconnect":
                        return

                    audio_data = packet.get("bytes")

                    if audio_data:
                        await session.send_realtime_input(
                            audio=types.Blob(
                                data=audio_data,
                                mime_type="audio/pcm;rate=16000",
                            )
                        )

            async def receive_gemini_responses():
                async for response in session.receive():
                    content = response.server_content

                    if content is None:
                        continue

                    if content.interrupted:
                        await websocket.send_json({
                            "type": "interrupted",
                        })

                    if content.input_transcription:
                        text = content.input_transcription.text or ""

                        if text:
                            await websocket.send_json({
                                "type": "input_transcription",
                                "text": text,
                            })

                    if content.output_transcription:
                        text = content.output_transcription.text or ""

                        if text:
                            await websocket.send_json({
                                "type": "output_transcription",
                                "text": text,
                            })

                    if content.model_turn:
                        for part in content.model_turn.parts:
                            inline_data = part.inline_data

                            if inline_data and inline_data.data:
                                await websocket.send_bytes(
                                    inline_data.data
                                )

                    if content.turn_complete:
                        await websocket.send_json({
                            "type": "turn_complete",
                        })

            mic_task = asyncio.create_task(
                send_microphone_audio()
            )
            response_task = asyncio.create_task(
                receive_gemini_responses()
            )

            tasks = {mic_task, response_task}

            try:
                _, pending = await asyncio.wait(
                    tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                for task in pending:
                    task.cancel()

                await asyncio.gather(
                    *tasks,
                    return_exceptions=True,
                )
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()

                await asyncio.gather(
                    *tasks,
                    return_exceptions=True,
                )

    except WebSocketDisconnect:
        logger.info("Live voice client disconnected.")

    except Exception:
        logger.exception("Live voice session failed.")

        try:
            await websocket.send_json({
                "type": "error",
                "message": (
                    "The live voice session failed. Check the backend "
                    "terminal for the Gemini error and model access."
                ),
            })
        except Exception:
            pass

    finally:
        try:
            await websocket.close()
        except Exception:
            pass

