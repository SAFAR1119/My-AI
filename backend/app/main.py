from groq import AsyncGroq
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

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
GROQ_ENABLE_WEB_SEARCH = (
    os.getenv("GROQ_ENABLE_WEB_SEARCH", "false").strip().lower()
    in {"1", "true", "yes", "on"}
)

groq_client = (
    AsyncGroq(api_key=GROQ_API_KEY)
    if GROQ_API_KEY
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
    content: str = Field(min_length=1, max_length=16000)


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
        "ai_configured": groq_client is not None,
        "provider": "Groq" if groq_client else None,
        "model": GROQ_MODEL if groq_client else None,
        "web_search_enabled": (
            GROQ_ENABLE_WEB_SEARCH and groq_client is not None
        ),
        "live_ai_configured": client is not None,
        "live_provider": "Gemini" if client else None,
        "live_model": GEMINI_LIVE_MODEL if client else None,
    }
    
    SYSTEM_PROMPT = """
You are My AI Voice, an AI assistant in an application developed by Safar Ahmed.
The application uses an underlying AI language model. Do not claim that Safar
Ahmed created the underlying model.

ANSWER QUALITY
- Answer the user's actual question directly.
- Use natural, professional, helpful language.
- Explain concepts clearly, with an appropriate amount of detail.
- Organize longer answers into meaningful sections.
- Avoid walls of text, excessive headings, repetitive conclusions, and unnecessary introductions.
- Do not use a heading for every short paragraph.
- Use **bold** selectively for important terms, not entire paragraphs.
- Do not include decorative formatting that adds no meaning.

MARKDOWN FORMATTING
- Return well-formed GitHub Flavored Markdown (GFM).
- Use short paragraphs for explanations.
- Use bullet lists for related points and numbered lists for ordered steps.
- Use headings only when they improve the structure of a longer answer.
- Use fenced code blocks with the correct language for code examples.
- Use meaningful link text for URLs when applicable.
- Never show raw Markdown syntax when the content can be represented as
  properly formatted Markdown.

TABLE RULES
- Use a table only when it makes information easier to compare or scan.
- For simple explanations, use paragraphs or bullet points instead of a table.
- Every table must have a descriptive header row followed by a valid Markdown
  separator row.
- Always use this structure:

  | Feature | Option A | Option B |
  | --- | --- | --- |
  | Example | Value A | Value B |

- Always include a blank line before and after a table.
- Never return pipe-separated rows without a header and separator.
- Do not put the entire answer in a table.
- Keep tables concise and avoid unnecessarily wide tables. For detailed
  comparisons, use separate sections or bullet lists instead.
- Use actual descriptive column names based on the topic, rather than
  generic labels such as Option 1 when the names are known.

LIST RULES
- Use proper Markdown list syntax with each item on its own line.
- Use numbered lists when sequence or priority matters.
- Keep list items concise and avoid excessive nesting.
- Do not use tables to represent ordinary lists.

RESPONSE STRUCTURE
- For a straightforward question, answer in a few clear sentences.
- For a complex question, give a brief overview followed by organized sections.
- For comparisons, state the main difference first, then use a concise table
  or clearly separated sections when appropriate.
- For instructions, provide clear steps in the right order.
- For code questions, explain important changes briefly and provide usable code.
- Do not invent facts, sources, or links.
"""




@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    allowed_roles = {"user", "assistant"}
    
    {
      "role": "system",
      "content": SYSTEM_PROMPT,
   }

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

    if groq_client is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Groq is not configured. Add GROQ_API_KEY "
                "to backend/.env and restart FastAPI."
            ),
        )

    system_message = {
        "role": "system",
        "content": (
            "You are My AI Voice, a personal AI assistant application "
            "developed by Safar Ahmed and powered by an AI language model. "
            "When asked who developed this application, say Safar Ahmed "
            "developed My AI Voice. Do not claim that Safar created or "
            "trained the underlying AI model. Be helpful, friendly, clear, "
            "and concise. For questions that need current information, "
            "use the available browser search tool when enabled. Never "
            "claim to have searched the web unless you actually used it. "
            "Be honest when you cannot verify current facts."
        ),
    }

    conversation = [
        {"role": message.role, "content": message.content}
        for message in request.messages[-20:]
    ]

    messages = [system_message, *conversation]

    async def request_completion(use_search: bool):
        options = {
            "model": GROQ_MODEL,
            "messages": messages,
            "max_completion_tokens": 1200,
            "temperature": 1,
        }

        if use_search:
            options["tools"] = [{"type": "browser_search"}]
            options["tool_choice"] = "auto"

        return await groq_client.chat.completions.create(**options)

    try:
        try:
            response = await request_completion(GROQ_ENABLE_WEB_SEARCH)

        except Exception as search_error:
            status_code = getattr(search_error, "status_code", None)

            # If the account or model cannot use browser search, retry
            # once as ordinary text chat instead of failing completely.
            if (
                GROQ_ENABLE_WEB_SEARCH
                and status_code in {400, 403, 404, 422}
            ):
                logger.warning(
                    "Groq browser search was rejected (HTTP %s). "
                    "Retrying without web search.",
                    status_code,
                )
                response = await request_completion(False)
            else:
                raise

        if not response.choices:
            raise HTTPException(
                status_code=502,
                detail="Groq returned no response choices.",
            )

        reply = response.choices[0].message.content

        if not isinstance(reply, str) or not reply.strip():
            raise HTTPException(
                status_code=502,
                detail="Groq returned an empty response.",
            )

        logger.info(
            "Groq response generated using model %s; web search configured: %s",
            GROQ_MODEL,
            GROQ_ENABLE_WEB_SEARCH,
        )

        return ChatResponse(
            reply=reply.strip(),
            mode="ai",
            sources=[],
        )

    except HTTPException:
        raise

    except Exception as exc:
        status_code = getattr(exc, "status_code", None)

        logger.exception("Groq chat request failed")

        if status_code == 429:
            raise HTTPException(
                status_code=429,
                detail=(
                    "The Groq free-tier rate limit has been reached. "
                    "Wait for the limit to reset, then try again."
                ),
            ) from exc

        if status_code in {401, 403}:
            raise HTTPException(
                status_code=502,
                detail=(
                    "Groq rejected the API key or model access. "
                    "Check your key and model permissions."
                ),
            ) from exc

        if status_code == 400:
            raise HTTPException(
                status_code=502,
                detail=(
                    "Groq rejected the request. Check GROQ_MODEL "
                    "and the backend terminal for details."
                ),
            ) from exc

        raise HTTPException(
            status_code=502,
            detail=(
                "The Groq AI request failed. Check the backend "
                "terminal for details."
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
                "You are My AI Voice, a personal AI assistant "
                "application developed by Safar Ahmed and powered "
                "by Google's Gemini model. If asked who developed "
                "this application, say Safar Ahmed developed My AI "
                "Voice. Do not claim that Safar created or trained "
                "the underlying Gemini model. Speak naturally and "
                "concisely. Use Google Search when useful for current "
                "information, and do not claim to have searched unless "
                "you actually used search."
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
                while True:
                    async for response in session.receive():
                        if response.go_away is not None:
                            logger.warning(
                                "Gemini Live session is approaching "
                                "its connection limit: %s",
                                response.go_away.time_left,
                            )

                            await websocket.send_json({
                                "type": "error",
                                "message": (
                                    "The Live session is about to close. "
                                    "Stop the conversation and start a "
                                    "new session."
                                ),
                            })
                            return

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

                    # The SDK receive iterator can end at a turn boundary.
                    # Keep this same session open for the next user turn.
                    await asyncio.sleep(0)

            sender_task = asyncio.create_task(send_microphone_audio())
            receiver_task = asyncio.create_task(receive_gemini_responses())
            tasks = {sender_task, receiver_task}

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
        logger.exception("Gemini Live API error")

        try:
            await websocket.send_json({
                "type": "error",
                "message": (
                    f"Gemini Live returned error {exc.code}. "
                    "Check the backend terminal for details."
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
                    "The live session failed. Check the backend "
                    "terminal for the exact error."
                ),
            })
        except Exception:
            pass

    finally:
        try:
            await websocket.close()
        except Exception:
            pass


