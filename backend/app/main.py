
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
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
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

client = (
    genai.Client(api_key=GEMINI_API_KEY)
    if GEMINI_API_KEY
    else None
)

app = FastAPI(
    title=APP_NAME,
    version="0.2.0",
    description="Personal AI voice and text assistant API.",
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


class ChatResponse(BaseModel):
    reply: str
    mode: str


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
                "I'm running in demo mode. Add a Gemini API key to enable "
                "real AI responses. Your backend is working correctly."
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
                    "Prefer concise responses that sound good aloud."
                ),
            ),
        )

        reply = (response.text or "").strip()

        if not reply:
            raise HTTPException(
                status_code=502,
                detail="The AI provider returned an empty response.",
            )

        return ChatResponse(reply=reply, mode="ai")

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Gemini request failed")
        raise HTTPException(
            status_code=502,
            detail=(
                "The AI request failed. Check your API key, model access, "
                "usage limits, and backend terminal for details."
            ),
        ) from exc
