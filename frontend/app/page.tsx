
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Source = {
  title: string;
  url: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

type ChatResponse = {
  reply: string;
  mode: "ai" | "demo";
  sources?: Source[];
};

type VoiceState = "idle" | "listening" | "processing" | "speaking";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/+$/, "");

const initialMessage: Message = {
  role: "assistant",
  content:
    "Hi! I'm your AI voice assistant. You can type a message or use your microphone to talk to me.",
};


function getCurrentVoiceState(
  ref: { current: VoiceState },
): VoiceState {
  return ref.current;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([initialMessage]);
  const [input, setInput] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<"ai" | "demo" | null>(null);
  const [error, setError] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceSupported, setVoiceSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceStateRef = useRef<VoiceState>("idle");
  const messagesRef = useRef<Message[]>([initialMessage]);
  const requestRef = useRef<AbortController | null>(null);
  const listeningRequestedRef = useRef(false);
  const mountedRef = useRef(false);
  const latestReplyRef = useRef("");

  const changeVoiceState = useCallback((next: VoiceState) => {
    voiceStateRef.current = next;
    setVoiceState(next);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    if (voiceStateRef.current === "speaking") {
      changeVoiceState("idle");
    }
  }, [changeVoiceState]);

  const speak = useCallback(
    (text: string) => {
      if (
        !autoSpeak ||
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        changeVoiceState("idle");
        return;
      }

      const cleanText = text.trim();
      if (!cleanText) {
        changeVoiceState("idle");
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = "en-US";
      utterance.rate = 1;
      utterance.pitch = 1;

      utterance.onstart = () => {
        if (mountedRef.current) changeVoiceState("speaking");
      };

      utterance.onend = () => {
        if (mountedRef.current && voiceStateRef.current === "speaking") {
          changeVoiceState("idle");
        }
      };

      utterance.onerror = () => {
        if (mountedRef.current && voiceStateRef.current === "speaking") {
          changeVoiceState("idle");
        }
      };

      latestReplyRef.current = cleanText;
      window.speechSynthesis.speak(utterance);
    },
    [autoSpeak, changeVoiceState],
  );

  const stopListening = useCallback(() => {
    listeningRequestedRef.current = false;

    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition may already have stopped.
    }

    if (voiceStateRef.current === "listening") {
      changeVoiceState("idle");
    }
  }, [changeVoiceState]);

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setError(
        "Speech recognition is not supported by this browser. Try the latest Chrome or Edge, or type your message instead.",
      );
      return;
    }

    setError("");

    // Stop any current speech so the assistant does not talk over you.
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    // Cancel an in-flight request when the user chooses to speak again.
    requestRef.current?.abort();
    requestRef.current = null;

    try {
      recognitionRef.current?.abort();
    } catch {
      // It may not have started yet.
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      if (mountedRef.current) changeVoiceState("listening");
    };

    recognition.onresult = (event) => {
      const result = event.results[event.resultIndex];
      if (result?.isFinal) {
        const transcript = result[0]?.transcript?.trim();

        if (transcript) {
          setInput((current) =>
            current.trim()
              ? `${current.trim()} ${transcript}`
              : transcript,
          );
        }
      }
    };

    recognition.onerror = (event) => {
      if (!mountedRef.current) return;

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError(
          "Microphone access was denied. Allow microphone permission in your browser settings and try again.",
        );
      } else if (event.error === "no-speech") {
        setError("I didn't hear anything. Try speaking a little louder.");
      } else if (event.error !== "aborted") {
        setError(`Microphone error: ${event.error}. You can type instead.`);
      }

      listeningRequestedRef.current = false;
      changeVoiceState("idle");
    };

    recognition.onend = () => {
      recognitionRef.current = null;

      if (mountedRef.current && voiceStateRef.current === "listening") {
        changeVoiceState("idle");
      }

      listeningRequestedRef.current = false;
    };

    recognitionRef.current = recognition;
    listeningRequestedRef.current = true;

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      listeningRequestedRef.current = false;
      changeVoiceState("idle");
      setError("Could not start the microphone. Please try again.");
    }
  }, [changeVoiceState]);

  const sendMessage = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();

      if (!text || voiceStateRef.current === "processing") return;

      setError("");
      stopListening();
      stopSpeaking();

      const nextMessages: Message[] = [
        ...messagesRef.current,
        { role: "user", content: text },
      ];

      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setInput("");
      changeVoiceState("processing");

      const controller = new AbortController();
      requestRef.current = controller;

      try {
        const response = await fetch(`${API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages.slice(-30).map(({ role, content}) => ({
              role, 
              content,
            })),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let detail = `The server returned ${response.status}.`;

          try {
            const data = await response.json();
            if (typeof data.detail === "string") detail = data.detail;
          } catch {
            // Keep the HTTP status message.
          }

          throw new Error(detail);
        }

        const data = (await response.json()) as ChatResponse;

        if (!data.reply?.trim()) {
          throw new Error("The assistant returned an empty response.");
        }

        const updatedMessages: Message[] = [
         ...nextMessages,
         {
           role: "assistant",
           content: data.reply.trim(),
           sources: data.sources ?? [],
         },
        ];

        messagesRef.current = updatedMessages;
        setMessages(updatedMessages);
        setMode(data.mode);
        latestReplyRef.current = data.reply.trim();

        if (mountedRef.current) {
          speak(data.reply);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;

        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again.",
        );
        changeVoiceState("idle");
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          if (getCurrentVoiceState(voiceStateRef) === "processing") {
            changeVoiceState("idle");
          }
        }
      }
    },
    [
      input,
      changeVoiceState,
      speak,
      stopListening,
      stopSpeaking,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;

    const browserWindow = window as SpeechWindow;
    setVoiceSupported(
      Boolean(
        browserWindow.SpeechRecognition ||
          browserWindow.webkitSpeechRecognition,
      ),
    );

    return () => {
      mountedRef.current = false;
      listeningRequestedRef.current = false;
      requestRef.current?.abort();
      recognitionRef.current?.abort();

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const handleMicrophoneClick = () => {
    if (voiceState === "listening") {
      stopListening();
    } else {
      startListening();
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage();
  };

  const statusText: Record<VoiceState, string> = {
    idle: "Ready when you are",
    listening: "Listening — speak now",
    processing: "Thinking...",
    speaking: "Speaking — you can interrupt",
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-mark">✳</div>
          <h1>My AI Voice</h1>
          <p className="sidebar-subtitle">Your personal AI assistant</p>
        </div>

        <div className="sidebar-status">
          <span
            className={`status-dot status-${voiceState}`}
            aria-hidden="true"
          />
          <span>{statusText[voiceState]}</span>
        </div>

        <div className="sidebar-settings">
          <label className="setting-row">
            <span>Speak replies aloud</span>
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(event) => {
                const enabled = event.target.checked;
                setAutoSpeak(enabled);

                if (!enabled) stopSpeaking();
              }}
            />
          </label>

          <p className="sidebar-hint">
            {voiceSupported
              ? "Browser voice input is available."
              : "Voice input needs Chrome or Edge. Text chat is still available."}
          </p>
        </div>

        <div className="sidebar-footer">
          <span>{mode === "ai" ? "Gemini AI connected" : "AI assistant"}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">PERSONAL ASSISTANT</p>
            <h2>Conversation</h2>
          </div>

          <button
            type="button"
            className="stop-button"
            onClick={stopSpeaking}
            disabled={voiceState !== "speaking"}
          >
            Stop voice
          </button>
        </header>

        <section
          className="conversation"
          aria-label="Chat conversation"
          aria-live="polite"
        >
          <div className="message-list">
            {messages.map((message, index) => (
              <article
                key={`${index}-${message.role}`}
                className={`message-row ${message.role}`}
              >
                <div className="message-avatar">
                  {message.role === "assistant" ? "✳" : "You"}
                </div>

                <div className="message-content">
                  <p className="message-author">
                    {message.role === "assistant" ? "Assistant" : "You"}
                  </p>
                  <div className="message-bubble">
                    <p>{message.content}</p>
                  </div>

                  
                {message.role === "assistant" &&
                   message.sources &&
                   message.sources.length > 0 && (
                     <div className="sources-list">
                       <p className="sources-heading">Web sources</p>
                       <ul>
                         {message.sources.map((source) => (
                           <li key={source.url}>
                             <a
                               href={source.url}
                               target="_blank"
                               rel="noopener noreferrer"
                             >
                               {source.title}
                             </a>
                           </li>
                         ))}
                       </ul>
                      </div>
                    )}

                </div>
              </article>
            ))}

            {voiceState === "processing" && (
              <div className="thinking" role="status">
                <span className="thinking-dots">
                  <span />
                  <span />
                  <span />
                </span>
                <span>Thinking of a response...</span>
              </div>
            )}
          </div>
        </section>

        {error && (
          <div className="error-message" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        <div className="composer-area">
          {voiceState === "listening" && (
            <div className="listening-indicator" role="status">
              <span className="listening-pulse" />
              Listening to your voice
            </div>
          )}

          {voiceState === "speaking" && (
            <div className="speaking-indicator" role="status">
              <span className="sound-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              Assistant is speaking. Tap the microphone to interrupt.
            </div>
          )}

          <form className="composer" onSubmit={handleSubmit}>
            <button
              type="button"
              className={`mic-button ${voiceState === "listening" ? "active" : ""}`}
              onClick={handleMicrophoneClick}
              disabled={voiceState === "processing"}
              aria-label={
                voiceState === "listening"
                  ? "Stop listening"
                  : "Start voice input"
              }
              title={
                voiceState === "listening"
                  ? "Stop listening"
                  : "Start voice input"
              }
            >
              {voiceState === "listening" ? "■" : "🎙"}
            </button>

            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                voiceState === "listening"
                  ? "Speak now, or type here..."
                  : "Ask me anything..."
              }
              aria-label="Your message"
              maxLength={4000}
              disabled={voiceState === "processing"}
            />

            <button
              type="submit"
              className="send-button"
              disabled={!input.trim() || voiceState === "processing"}
            >
              Send <span aria-hidden="true">↑</span>
            </button>
          </form>

          <p className="composer-note">
            AI can make mistakes. Check important information.
          </p>
        </div>
      </section>
    </main>
  );
}
