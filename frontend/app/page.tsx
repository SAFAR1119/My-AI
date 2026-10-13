
"use client";

import Link from "next/link";
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

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const SUGGESTIONS = [
  {
    title: "Explain a concept",
    prompt: "Explain how large language models work in simple terms.",
  },
  {
    title: "Get today's news",
    prompt: "What are the top technology news stories today?",
  },
  {
    title: "Plan my day",
    prompt: "Help me plan a productive day with focused work blocks.",
  },
  {
    title: "Practice speaking",
    prompt: "Let's have a short English conversation practice.",
  },
];

type IconProps = { size?: number };

function Icon({
  size = 18,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const SparkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
  </Icon>
);

const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
);

const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" />
  </Icon>
);

const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
);

const SpeakerIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Icon>
);

const SpeakerOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </Icon>
);

const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </Icon>
);

const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

const WaveIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2" />
  </Icon>
);

const ChatIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </Icon>
);

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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
    (text: string, force = false) => {
      if (
        (!autoSpeak && !force) ||
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
        setSidebarOpen(false);
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
      setSidebarOpen(false);
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
        setSpeakingIndex(updatedMessages.length - 1);

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


  // Grow the message box with its content, up to a comfortable limit.
  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [input]);

  // Keep the newest message in view.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, voiceState]);

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

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const handleAutoSpeakToggle = () => {
    const enabled = !autoSpeak;
    setAutoSpeak(enabled);

    if (!enabled) {
      stopSpeaking();
    }
  };

  const handleCopy = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      window.setTimeout(() => {
        setCopiedIndex((current) => (current === index ? null : current));
      }, 1600);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  };

  const handleReadAloud = (text: string, index: number) => {
    if (voiceState === "speaking" && speakingIndex === index) {
      stopSpeaking();
      return;
    }

    setSpeakingIndex(index);
    speak(text, true);
  };

  const statusText: Record<VoiceState, string> = {
    idle: "Ready",
    listening: "Listening",
    processing: "Thinking",
    speaking: "Speaking",
  };

  const hasUserMessages = messages.some(
    (message) => message.role === "user",
  );

  const activeTitle =
    chatSessions.find((session) => session.id === activeChatId)?.title ??
    "New conversation";

  const isProcessing = voiceState === "processing";
  const isListening = voiceState === "listening";

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""}`}
        aria-label="Conversations"
      >
        <div className="sidebar-header">
          <div className="brand-lockup">
            <span className="brand-logo">
              <SparkIcon size={18} />
            </span>
            <div className="brand-text">
              <strong>My AI Voice</strong>
              <span>by Safar Ahmed</span>
            </div>
          </div>

          <button
            type="button"
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="new-chat-button"
            onClick={() => {
              startNewConversation();
              setSidebarOpen(false);
            }}
          >
            <PlusIcon size={16} />
            New chat
          </button>

          <Link href="/live" className="sidebar-link">
            <WaveIcon size={16} />
            Live voice mode
          </Link>
        </div>

        <nav className="history-nav" aria-label="Recent conversations">
          <p className="sidebar-label">Recent</p>

          <ul className="history-list">
            {chatSessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`history-item ${
                    session.id === activeChatId ? "active" : ""
                  }`}
                  onClick={() => switchConversation(session)}
                  title={session.title}
                  aria-current={
                    session.id === activeChatId ? "page" : undefined
                  }
                >
                  <ChatIcon size={15} />
                  <span className="history-title">{session.title}</span>
                  <span className="history-date">
                    {formatChatDate(session.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <span
            className={`connection-indicator ${
              mode === "ai" ? "connected" : ""
            }`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {mode === "ai" ? "Groq AI connected" : "Personal assistant"}
            </strong>
            <span>History is saved in this browser</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="chat-header">
          <button
            type="button"
            className="icon-button menu-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <MenuIcon />
          </button>

          <h1 className="chat-title">{activeTitle}</h1>

          <div className="chat-header-actions">
            <span className={`state-pill state-${voiceState}`}>
              <span className="state-dot" aria-hidden="true" />
              {statusText[voiceState]}
            </span>

            <button
              type="button"
              className="icon-button header-new-chat"
              onClick={startNewConversation}
              aria-label="New chat"
              title="New chat"
            >
              <PlusIcon />
            </button>
          </div>
        </header>

        <section
          className="conversation"
          aria-label="Chat conversation"
          aria-live="polite"
        >
          <div className="conversation-inner">
            {!hasUserMessages ? (
              <div className="welcome">
                <span className="welcome-logo">
                  <SparkIcon size={28} />
                </span>
                <h2>How can I help you today?</h2>
                <p>
                  Type a message or tap the microphone to talk. Turn on
                  voice replies to hear the answers out loud.
                </p>

                <div className="suggestion-grid">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.title}
                      type="button"
                      className="suggestion-card"
                      onClick={() => void sendMessage(suggestion.prompt)}
                      disabled={isProcessing}
                    >
                      <strong>{suggestion.title}</strong>
                      <span>{suggestion.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message, index) => (
                  <article
                    key={`${index}-${message.role}`}
                    className={`message ${message.role}`}
                  >
                    {message.role === "assistant" && (
                      <span className="message-avatar">
                        <SparkIcon size={16} />
                      </span>
                    )}

                    <div className="message-body">
                      <div className="message-text">{message.content}</div>

                      {message.role === "assistant" &&
                        message.sources &&
                        message.sources.length > 0 && (
                          <div className="source-list">
                            <span className="source-label">Sources</span>
                            {message.sources.map((source) => (
                              <a
                                key={source.url}
                                className="source-chip"
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={source.title}
                              >
                                <span className="source-host">
                                  {getHostname(source.url)}
                                </span>
                                <span className="source-title">
                                  {source.title}
                                </span>
                              </a>
                            ))}
                          </div>
                        )}

                      {message.role === "assistant" && (
                        <div className="message-actions">
                          <button
                            type="button"
                            className="action-button"
                            onClick={() =>
                              void handleCopy(message.content, index)
                            }
                            aria-label="Copy message"
                            title="Copy"
                          >
                            {copiedIndex === index ? (
                              <CheckIcon size={15} />
                            ) : (
                              <CopyIcon size={15} />
                            )}
                          </button>

                          <button
                            type="button"
                            className={`action-button ${
                              voiceState === "speaking" &&
                              speakingIndex === index
                                ? "active"
                                : ""
                            }`}
                            onClick={() =>
                              handleReadAloud(message.content, index)
                            }
                            disabled={isListening}
                            aria-label={
                              voiceState === "speaking" &&
                              speakingIndex === index
                                ? "Stop reading aloud"
                                : "Read aloud"
                            }
                            title={
                              voiceState === "speaking" &&
                              speakingIndex === index
                                ? "Stop"
                                : "Read aloud"
                            }
                          >
                            {voiceState === "speaking" &&
                            speakingIndex === index ? (
                              <StopIcon size={15} />
                            ) : (
                              <SpeakerIcon size={15} />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}

                {isProcessing && (
                  <article className="message assistant" role="status">
                    <span className="message-avatar">
                      <SparkIcon size={16} />
                    </span>
                    <div className="message-body">
                      <span className="typing-dots" aria-label="Thinking">
                        <span />
                        <span />
                        <span />
                      </span>
                    </div>
                  </article>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </section>

        <footer className="composer-area">
          <div className="composer-inner">
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setError("")}
                  aria-label="Dismiss error"
                >
                  <CloseIcon size={16} />
                </button>
              </div>
            )}

            <div className="composer-toolbar">
              <button
                type="button"
                role="switch"
                aria-checked={autoSpeak}
                className={`voice-toggle ${autoSpeak ? "on" : ""}`}
                onClick={handleAutoSpeakToggle}
              >
                {autoSpeak ? (
                  <SpeakerIcon size={16} />
                ) : (
                  <SpeakerOffIcon size={16} />
                )}
                <span>Voice replies</span>
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
              </button>

              <div className="toolbar-status" role="status">
                {isListening && (
                  <span className="live-status listening">
                    <span className="pulse-dot" />
                    Listening…
                  </span>
                )}

                {voiceState === "speaking" && (
                  <>
                    <span className="live-status speaking">
                      <span className="voice-wave" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      Speaking
                    </span>
                    <button
                      type="button"
                      className="stop-voice-button"
                      onClick={stopSpeaking}
                    >
                      <StopIcon size={13} />
                      Stop
                    </button>
                  </>
                )}

                {!voiceSupported &&
                  !isListening &&
                  voiceState !== "speaking" && (
                    <span className="toolbar-hint">
                      Voice input works in Chrome or Edge
                    </span>
                  )}
              </div>
            </div>

            <form
              className={`composer ${isListening ? "listening" : ""}`}
              onSubmit={handleSubmit}
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  isListening ? "Listening… speak now" : "Message My AI Voice"
                }
                aria-label="Your message"
                maxLength={4000}
              />

              <div className="composer-actions">
                <span className="composer-hint">
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd> +{" "}
                  <kbd>Enter</kbd> for a new line
                </span>

                <button
                  type="button"
                  className={`mic-button ${isListening ? "active" : ""}`}
                  onClick={handleMicrophoneClick}
                  disabled={isProcessing}
                  aria-label={
                    isListening ? "Stop listening" : "Start voice input"
                  }
                  title={isListening ? "Stop listening" : "Voice input"}
                >
                  {isListening ? <StopIcon size={16} /> : <MicIcon />}
                </button>

                <button
                  type="submit"
                  className="send-button"
                  disabled={!input.trim() || isProcessing}
                  aria-label="Send message"
                  title="Send"
                >
                  <SendIcon />
                </button>
              </div>
            </form>

            <p className="composer-note">
              My AI Voice can make mistakes. Check important information.
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}
