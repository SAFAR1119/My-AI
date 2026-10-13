
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

type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
};

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

const STORAGE_KEY = "my-ai-voice-conversations-v1";
const MAX_CHATS = 30;
const MAX_TITLE_LENGTH = 38;

const initialMessage: Message = {
  role: "assistant",
  content:
    "Hi! I'm My AI Voice, developed by Safar Ahmed and powered by an AI language model. You can type a message or use your microphone to talk to me.",
};

function createChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createChatSession(): ChatSession {
  return {
    id: createChatId(),
    title: "New conversation",
    messages: [{ ...initialMessage }],
    updatedAt: Date.now(),
  };
}

function isChatSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<ChatSession>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.updatedAt !== "number" ||
    !Array.isArray(candidate.messages)
  ) {
    return false;
  }

  return candidate.messages.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;

    const message = item as Partial<Message>;

    return (
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string"
    );
  });
}

function getChatTitle(messages: Message[]): string {
  const firstUserMessage = messages.find(
    (message) => message.role === "user",
  );

  if (!firstUserMessage) return "New conversation";

  const normalized = firstUserMessage.content.replace(/\s+/g, " ").trim();

  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function getCurrentVoiceState(
  ref: { current: VoiceState },
): VoiceState {
  return ref.current;
}

function formatChatDate(timestamp: number): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return "";

  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([initialMessage]);
  const [input, setInput] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<"ai" | "demo" | null>(null);
  const [error, setError] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [voiceSupported, setVoiceSupported] = useState(false);

  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceStateRef = useRef<VoiceState>("idle");
  const messagesRef = useRef<Message[]>([initialMessage]);
  const activeChatIdRef = useRef("");
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const latestReplyRef = useRef("");

  const changeVoiceState = useCallback((next: VoiceState) => {
    voiceStateRef.current = next;
    setVoiceState(next);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
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

      latestReplyRef.current = cleanText;

      utterance.onstart = () => {
        if (mountedRef.current) {
          changeVoiceState("speaking");
        }
      };

      utterance.onend = () => {
        if (
          mountedRef.current &&
          voiceStateRef.current === "speaking"
        ) {
          changeVoiceState("idle");
        }
      };

      utterance.onerror = () => {
        if (
          mountedRef.current &&
          voiceStateRef.current === "speaking"
        ) {
          changeVoiceState("idle");
        }
      };

      window.speechSynthesis.speak(utterance);
    },
    [autoSpeak, changeVoiceState],
  );

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition may already have stopped.
    }

    if (voiceStateRef.current === "listening") {
      changeVoiceState("idle");
    }
  }, [changeVoiceState]);

  const cancelPendingRequest = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  // Restore saved conversations when the page first loads.
  useEffect(() => {
    mountedRef.current = true;

    let restoredSessions: ChatSession[] = [];

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);

      if (stored) {
        const parsed: unknown = JSON.parse(stored);

        if (Array.isArray(parsed)) {
          restoredSessions = parsed
            .filter(isChatSession)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_CHATS);
        }
      }
    } catch (restoreError) {
      console.error("Could not restore saved conversations:", restoreError);
    }

    if (restoredSessions.length === 0) {
      restoredSessions = [createChatSession()];
    }

    const active = restoredSessions[0];

    setChatSessions(restoredSessions);
    setActiveChatId(active.id);
    activeChatIdRef.current = active.id;

    messagesRef.current = active.messages;
    setMessages(active.messages);

    setStorageLoaded(true);

    const browserWindow = window as SpeechWindow;

    setVoiceSupported(
      Boolean(
        browserWindow.SpeechRecognition ||
          browserWindow.webkitSpeechRecognition,
      ),
    );

    return () => {
      mountedRef.current = false;

      cancelPendingRequest();

      try {
        recognitionRef.current?.abort();
      } catch {
        // Recognition may already have stopped.
      }

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [cancelPendingRequest]);

  // Keep the current conversation synchronized with React state.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Update the active chat's title, message list, and last activity time.
  useEffect(() => {
    if (!storageLoaded || !activeChatId) return;

    setChatSessions((current) => {
      const active = current.find(
        (session) => session.id === activeChatId,
      );

      if (!active) return current;

      const updated: ChatSession = {
        ...active,
        title: getChatTitle(messages),
        messages,
        updatedAt: Date.now(),
      };

      // Show the most recently active conversation first.
      return [
        updated,
        ...current.filter((session) => session.id !== activeChatId),
      ].slice(0, MAX_CHATS);
    });
  }, [messages, activeChatId, storageLoaded]);

  // Save conversations to this browser after each change.
  useEffect(() => {
    if (!storageLoaded) return;

    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(chatSessions.slice(0, MAX_CHATS)),
      );
    } catch (saveError) {
      console.error("Could not save conversations:", saveError);
      setError(
        "The browser could not save your conversation history. Check your browser storage settings.",
      );
    }
  }, [chatSessions, storageLoaded]);

  const startNewConversation = useCallback(() => {
    stopListening();
    stopSpeaking();
    cancelPendingRequest();

    const session = createChatSession();

    activeChatIdRef.current = session.id;
    messagesRef.current = session.messages;

    setChatSessions((current) => [
      session,
      ...current.filter((item) => item.id !== session.id),
    ].slice(0, MAX_CHATS));

    setActiveChatId(session.id);
    setMessages(session.messages);

    setInput("");
    setError("");
    setMode(null);
    changeVoiceState("idle");
  }, [
    stopListening,
    stopSpeaking,
    cancelPendingRequest,
    changeVoiceState,
  ]);

  const switchConversation = useCallback(
    (session: ChatSession) => {
      if (session.id === activeChatIdRef.current) {
        setHistoryOpen(false);
        return;
      }

      stopListening();
      stopSpeaking();
      cancelPendingRequest();

      activeChatIdRef.current = session.id;
      messagesRef.current = session.messages;

      setActiveChatId(session.id);
      setMessages(session.messages);

      setInput("");
      setError("");
      setMode(null);
      changeVoiceState("idle");
      setHistoryOpen(false);
    },
    [
      stopListening,
      stopSpeaking,
      cancelPendingRequest,
      changeVoiceState,
    ],
  );

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

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    cancelPendingRequest();

    try {
      recognitionRef.current?.abort();
    } catch {
      // Recognition may not have started.
    }

    const recognition = new SpeechRecognition();

    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      if (mountedRef.current) {
        changeVoiceState("listening");
      }
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

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        setError(
          "Microphone access was denied. Allow microphone permission in your browser settings and try again.",
        );
      } else if (event.error === "no-speech") {
        setError("I didn't hear anything. Try speaking a little louder.");
      } else if (event.error !== "aborted") {
        setError(`Microphone error: ${event.error}. You can type instead.`);
      }

      changeVoiceState("idle");
    };

    recognition.onend = () => {
      recognitionRef.current = null;

      if (
        mountedRef.current &&
        voiceStateRef.current === "listening"
      ) {
        changeVoiceState("idle");
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      changeVoiceState("idle");
      setError("Could not start the microphone. Please try again.");
    }
  }, [cancelPendingRequest, changeVoiceState]);

  const sendMessage = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();

      if (
        !text ||
        getCurrentVoiceState(voiceStateRef) === "processing"
      ) {
        return;
      }

      const sendChatId = activeChatIdRef.current;

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
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: nextMessages.slice(-30).map(
              ({ role, content }) => ({
                role,
                content,
              }),
            ),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let detail = `The server returned ${response.status}.`;

          try {
            const data = await response.json();

            if (typeof data.detail === "string") {
              detail = data.detail;
            }
          } catch {
            // Keep the HTTP status message.
          }

          throw new Error(detail);
        }

        const data = (await response.json()) as ChatResponse;

        if (!data.reply?.trim()) {
          throw new Error("The assistant returned an empty response.");
        }

        // A late response must not appear in a different selected chat.
        if (activeChatIdRef.current !== sendChatId) {
          return;
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
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }

        if (activeChatIdRef.current === sendChatId) {
          setError(
            err instanceof Error
              ? err.message
              : "Something went wrong. Please try again.",
          );
        }
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;

          if (
            mountedRef.current &&
            activeChatIdRef.current === sendChatId &&
            getCurrentVoiceState(voiceStateRef) === "processing"
          ) {
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
        <div className="brand-block">
          <div className="brand-mark">✳</div>
          <h1>My AI Voice</h1>
          <p className="sidebar-subtitle">
            Developed by Safar Ahmed
          </p>
        </div>

        <button
          type="button"
          className="new-chat-button"
          onClick={startNewConversation}
        >
          <span aria-hidden="true">＋</span>
          New conversation
        </button>

        <div className="sidebar-status">
          <span
            className={`status-dot status-${voiceState}`}
            aria-hidden="true"
          />
          <span>{statusText[voiceState]}</span>
        </div>

        <section className="sidebar-conversations">
          <div className="sidebar-section-heading">
            <span>Recent conversations</span>

            <button
              type="button"
              className="history-toggle"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-label={
                historyOpen ? "Collapse history" : "Expand history"
              }
            >
              {historyOpen ? "−" : "+"}
            </button>
          </div>

          {historyOpen && (
            <div className="sidebar-chat-list">
              {chatSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`chat-session-button ${
                    session.id === activeChatId ? "active" : ""
                  }`}
                  onClick={() => switchConversation(session)}
                  title={session.title}
                >
                  <span className="chat-session-title">
                    {session.title}
                  </span>
                  <span className="chat-session-date">
                    {formatChatDate(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="sidebar-settings">
          <label className="setting-row">
            <span>Speak replies aloud</span>
            <input
              type="checkbox"
              checked={autoSpeak}
              onChange={(event) => {
                const enabled = event.target.checked;
                setAutoSpeak(enabled);

                if (!enabled) {
                  stopSpeaking();
                }
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
          <span>
            {mode === "ai"
              ? "Groq AI connected"
              : "Your personal AI assistant"}
          </span>
          <span className="storage-note">Saved in this browser</span>
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
                    {message.role === "assistant"
                      ? "My AI Voice"
                      : "You"}
                  </p>

                  <div className="message-bubble">
                    <p>{message.content}</p>
                  </div>

                  {message.role === "assistant" &&
                    index > 0 &&
                    index === messages.length - 1 && (
                      <button
                        type="button"
                        className="replay-button"
                        onClick={() => speak(message.content)}
                        disabled={voiceState === "listening"}
                      >
                        <span aria-hidden="true">▶</span>
                        Replay voice
                      </button>
                    )}

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
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
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
              className={`mic-button ${
                voiceState === "listening" ? "active" : ""
              }`}
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
