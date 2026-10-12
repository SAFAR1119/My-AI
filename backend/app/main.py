
import asyncio
import logging
import os
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
GEMINI_LIVE_MODEL = os.getenv(
    "GEMINI_LIVE_MODEL",
    "gemini-3.8-live",
).strip()

client = (
    genai.Client(api_key=GEMINI_API_KEY)
    if GEMINI_API_KEY
    else None
)

app = FastAPI(
    title=APP_NAME,
    version="0.4.0",
    description="Personal AI assistant with text, web search, and live voice.",
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
    if isinstance(obj, dict):
        return obj.get(name)

    return getattr(obj, name, None)


def extract_sources(response: Any) -> list[Source]:
    sources: list[Source] = []
    seen_urls: set[str] = set()

    for candidate in read_field(response, "candidates") or []:
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
                    title=(
                        title.strip()
                        if isinstance(title, str) and title.strip()
                        else parsed_url.netloc
                    ),
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
        "live_model": GEMINI_LIVE_MODEL if client else None,
        "web_search_enabled": client is not None,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    allowed_roles = {"user", "assistant"}

    if any(message.role not in allowed_roles for message in request.messages):
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
                "You are My AI Voice, a personal AI assistant application "
                "developed by Safar Ahmed. Safar Ahmed is the developer of "
                "this application and its user-facing experience. The application "
                "uses Google's Gemini model as its underlying AI engine. "
                "When someone asks who created you, who made you, or who your "
                "developer is, answer naturally that you are My AI Voice, "
                "developed by Safar Ahmed and powered by Gemini. Do not answer "
                "only 'Google' or 'Gemini' when the question is about who developed "
                "this application. Do not claim Safar trained or created the "
                "underlying Gemini model. If asked who created Gemini itself, "
                "explain that Google developed Gemini. "
                "Answer naturally, accurately, and clearly. Prefer concise "
                "responses that sound good aloud. For recent events, current "
                "information, prices, or facts that may have changed, use Google "
                "Search when it helps answer accurately. Do not claim to have "
                "searched unless search was actually used."
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
            "Text response generated with %d source(s).",
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
            "Gemini text API error: code=%s, message=%s",
            exc.code,
            exc.message,
        )

        if exc.code == 503:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Gemini is temporarily overloaded. "
                    "Wait briefly and try again."
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

        raise HTTPException(
            status_code=502,
            detail=f"Gemini returned API error {exc.code}.",
        ) from exc

    except Exception as exc:
        logger.exception("Unexpected text chat failure")
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

    try:
        config = {
            "response_modalities": ["AUDIO"],
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "tools": [
                {"google_search": {}},
            ],
            "speech_config": {
                "voice_config": {
                    "prebuilt_voice_config": {
                        "voice_name": "Kore",
                    }
                }
            },
            
                "system_instruction": (
                    "You are My AI Voice, a friendly personal AI assistant "
                    "application developed by Safar Ahmed and powered by Google's "
                    "Gemini model. Safar Ahmed is the developer of this application. "
                    "When users ask who created you, who made you, or who developed "
                    "this assistant, tell them that Safar Ahmed developed My AI Voice "
                    "and that Gemini powers its AI responses. Do not say that Google "
                    "created this application. Do not claim that Safar trained or "
                    "created the underlying Gemini model. If someone asks who created "
                    "Gemini itself, explain that Google developed Gemini. "
                    "Speak naturally and conversationally. Keep responses clear and "
                    "reasonably concise. Listen to the user's request and answer what "
                    "they actually asked. For current events, recent information, or "
                    "facts that may have changed, use Google Search when useful. "
                    "Do not claim to have searched unless search was actually used."
                ),

        }

        async with client.aio.live.connect(
            model=GEMINI_LIVE_MODEL,
            config=config,
        ) as session:
            await websocket.send_json({
                "type": "ready",
                "model": GEMINI_LIVE_MODEL,
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
                # The SDK's receive() iterator completes at the end
                # of an interaction. Re-enter it for later turns
                # without closing the persistent Live session.
                while True:
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

            mic_task = asyncio.create_task(send_microphone_audio())
            response_task = asyncio.create_task(
                receive_gemini_responses()
            )
            tasks = {mic_task, response_task}

            try:
                done, pending = await asyncio.wait(
                    tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                for task in pending:
                    task.cancel()

                await asyncio.gather(
                    *pending,
                    return_exceptions=True,
                )

                for task in done:
                    if task.cancelled():
                        continue

                    task_error = task.exception()

                    if task_error is not None:
                        raise task_error

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

    except errors.APIError as exc:
        logger.warning(
            "Gemini Live API error: code=%s, message=%s",
            exc.code,
            exc.message,
        )

        try:
            await websocket.send_json({
                "type": "error",
                "message": (
                    f"Gemini Live returned error {exc.code}. "
                    "Check the model, API access, and usage limits."
                ),
            })
        except Exception:
            pass

    except Exception:
        logger.exception("Live voice session failed.")

        try:
            await websocket.send_json({
                "type": "error",
                "message": (
                    "The live session failed. Check the backend terminal "
                    "for details."
                ),
            })
        except Exception:
            pass

    finally:
        try:
            await websocket.close()
        except Exception:
            pass
