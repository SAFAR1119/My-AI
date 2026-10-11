
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type ChatResponse = {
  reply: string;
  mode: "ai" | "demo";
};

type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hey! I'm your personal AI assistant. Type a message or tap the microphone to talk.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [mode, setMode] = useState<"ai" | "demo" | null>(null);
  const [error, setError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  function speak(text: string) {
    if (!("speechSynthesis" in window)) {
      setError("Speech playback is not supported in this browser.");
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    window.speechSynthesis.speak(utterance);
  }

  async function sendMessage(
    event?: FormEvent<HTMLFormElement>,
    override?: string,
  ) {
    event?.preventDefault();

    const content = (override ?? input).trim();

    if (!content || loading) return;

    const userMessage: Message = { role: "user", content };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setInput("");
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.slice(-20),
        }),
      });

      const data = (await response.json()) as ChatResponse & {
        detail?: string;
      };

      if (!response.ok) {
        throw new Error(data.detail ?? "Unable to get a response.");
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: data.reply,
      };

      setMessages((current) => [...current, assistantMessage]);
      setMode(data.mode);
      speak(data.reply);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect to the backend.",
      );
    } finally {
      setLoading(false);
    }
  }

  function startListening() {
    const speechWindow = window as SpeechWindow;
    const Recognition =
      speechWindow.SpeechRecognition ??
      speechWindow.webkitSpeechRecognition;

    if (!Recognition) {
      setError(
        "Speech recognition is not supported here. Try a recent version of Chrome or Edge.",
      );
      return;
    }

    setError("");

    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognitionRef.current = recognition;

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ")
        .trim();

      setListening(false);

      if (transcript) {
        void sendMessage(undefined, transcript);
      }
    };

    recognition.onerror = () => {
      setListening(false);
      setError("Microphone recognition failed. Check browser permissions.");
    };

    recognition.onend = () => setListening(false);

    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      setError("Could not start the microphone. Try again.");
    }
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-icon">✳</span>
          <span>my<span className="accent">voice</span>.ai</span>
        </a>

        <button
          className="new-chat"
          onClick={() => {
            setMessages([
              {
                role: "assistant",
                content: "New conversation started. What is on your mind?",
              },
            ]);
            setMode(null);
            setError("");
          }}
        >
          <span>＋</span> New conversation
        </button>

        <div className="sidebar-label">YOUR ASSISTANT</div>
        <div className="assistant-card">
          <span className="assistant-avatar">✳</span>
          <div>
            <strong>Personal AI</strong>
            <p>Voice & text assistant</p>
          </div>
          <span className="online-dot" />
        </div>

        <div className="sidebar-bottom">
          <span className="status-dot" />
          Local development
          <p>Built by you, for you.</p>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="mobile-brand">✳ myvoice.ai</span>
            <span className="connection-label">
              <span className="status-dot" />
              {mode === "ai"
                ? "AI connected"
                : mode === "demo"
                  ? "Demo mode"
                  : "Ready to connect"}
            </span>
          </div>
          <span className="model-label">PERSONAL ASSISTANT</span>
        </header>

        <div className="conversation">
          {messages.length === 1 && (
            <section className="welcome">
              <div className="welcome-orb">
                <div className="orb-inner">✳</div>
              </div>
              <p className="eyebrow">YOUR SPACE. YOUR AI.</p>
              <h1>
                A little less typing.
                <br />
                <span>A little more talking.</span>
              </h1>
              <p className="welcome-description">
                Ask a question, explore an idea, or just start a conversation.
                Your personal assistant is ready.
              </p>

              <div className="suggestions">
                {[
                  "Give me a daily motivation",
                  "Explain how AI works",
                  "Help me plan my day",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => void sendMessage(undefined, suggestion)}
                    disabled={loading}
                  >
                    {suggestion} <span>↗</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="message-list">
            {messages.slice(1).map((message, index) => (
              <article
                key={`${index}-${message.role}`}
                className={`message-row ${message.role}`}
              >
                <div className="message-avatar">
                  {message.role === "user" ? "Y" : "✳"}
                </div>
                <div className="message-content">
                  <span className="message-author">
                    {message.role === "user" ? "You" : "My AI"}
                  </span>
                  <p>{message.content}</p>
                  {message.role === "assistant" && (
                    <button
                      className="small-action"
                      onClick={() => speak(message.content)}
                      aria-label="Play assistant response"
                    >
                      ▶ Listen
                    </button>
                  )}
                </div>
              </article>
            ))}

            {loading && (
              <div className="thinking">
                <span className="message-avatar">✳</span>
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Thinking...</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="composer-area">
          {error && <p className="error-message">{error}</p>}

          <form className="composer" onSubmit={(event) => void sendMessage(event)}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask me anything..."
              rows={1}
              maxLength={4000}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              aria-label="Your message"
            />

            <div className="composer-actions">
              <span className="composer-hint">
                {listening ? "Listening to you..." : "Enter to send"}
              </span>

              {speaking && (
                <button
                  type="button"
                  className="icon-button stop-button"
                  onClick={stopSpeaking}
                  title="Stop voice playback"
                >
                  ■
                </button>
              )}

              <button
                type="button"
                className={`icon-button mic-button ${listening ? "listening" : ""}`}
                onClick={listening ? stopListening : startListening}
                title={listening ? "Stop listening" : "Start voice input"}
                aria-label={listening ? "Stop listening" : "Start voice input"}
              >
                {listening ? "■" : "🎙"}
              </button>

              <button
                type="submit"
                className="send-button"
                disabled={loading || !input.trim()}
                aria-label="Send message"
              >
                ↑
              </button>
            </div>
          </form>
          <p className="disclaimer">
            Your personal AI. Responses may be inaccurate.
          </p>
        </div>
      </section>
    </main>
  );
}
