
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI, APIError
from pydantic import BaseModel, Field

load_dotenv()

APP_NAME = os.getenv("APP_NAME", "My AI Voice")
FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "http://localhost:3000",
)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

client = (
    AsyncOpenAI(api_key=OPENAI_API_KEY)
    if OPENAI_API_KEY
    else None
)

app = FastAPI(
    title=APP_NAME,
    version="0.1.0",
    description="Backend for a personal AI voice assistant.",
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
        "model": OPENAI_MODEL if client else None,
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
                "I'm running in demo mode, so I can't generate a real "
                "AI response yet. Your chat interface and backend are "
                "connected successfully. Add an API key to enable the "
                "AI brain."
            ),
            mode="demo",
        )

    try:
        response = await client.responses.create(
            model=OPENAI_MODEL,
            instructions=(
                "You are a friendly personal AI voice assistant. "
                "Answer naturally and clearly. Prefer concise responses "
                "that sound good when spoken aloud."
            ),
            input=[
                {
                    "role": message.role,
                    "content": message.content,
                }
                for message in request.messages
            ],
        )

        reply = response.output_text.strip()

        if not reply:
            raise HTTPException(
                status_code=502,
                detail="The AI returned an empty response.",
            )

        return ChatResponse(reply=reply, mode="ai")

    except HTTPException:
        raise
    except APIError as exc:
        raise HTTPException(
            status_code=502,
            detail="The AI provider request failed. Check API access, "
            "billing, model availability, and backend logs.",
        ) from exc
