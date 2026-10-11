
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type LiveServerEvent = {
  type: string;
  text?: string;
  message?: string;
  model?: string;
};

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/+$/, "");

const LIVE_URL = `${API_URL.replace(/^http/, "ws")}/api/live`;

function convertToPcm16(
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer {
  const ratio = sampleRate / 16000;
  const outputLength = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      Math.floor((i + 1) * ratio),
      samples.length,
    );

    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      sum += samples[j];
      count++;
    }

    const sample = count > 0 ? sum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));

    pcm[i] =
      clamped < 0
        ? clamped * 0x8000
        : clamped * 0x7fff;
  }

  return pcm.buffer as ArrayBuffer;
}

export default function LiveVoicePage() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userCaption, setUserCaption] = useState("");
  const [assistantCaption, setAssistantCaption] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const muteGainRef = useRef<GainNode | null>(null);

  const playbackNodesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const playbackCursorRef = useRef(0);

  const userTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");
  const manuallyStoppingRef = useRef(false);
  const startInProgressRef = useRef(false);

  const clearPlayback = useCallback(() => {
    for (const node of playbackNodesRef.current) {
      try {
        node.stop();
      } catch {
        // The audio node may already have stopped.
      }

      try {
        node.disconnect();
      } catch {
        // It may already be disconnected.
      }
    }

    playbackNodesRef.current.clear();
    playbackCursorRef.current =
      contextRef.current?.currentTime ?? 0;
  }, []);

  const releaseMedia = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    inputSourceRef.current?.disconnect();
    inputSourceRef.current = null;

    muteGainRef.current?.disconnect();
    muteGainRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const context = contextRef.current;
    contextRef.current = null;

    if (context && context.state !== "closed") {
      void context.close();
    }

    clearPlayback();
  }, [clearPlayback]);

  const stopLive = useCallback(() => {
    manuallyStoppingRef.current = true;

    const socket = socketRef.current;
    socketRef.current = null;

    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "User stopped the live session");
    }

    releaseMedia();

    setConnected(false);
    setStatus("Not connected");
    setUserCaption("");
    setAssistantCaption("");

    userTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
  }, [releaseMedia]);

  const playAudioChunk = useCallback(async (data: ArrayBuffer) => {
    const context = contextRef.current;

    if (!context || context.state === "closed") return;

    // Gemini Live audio output is raw, little-endian PCM at 24 kHz.
    if (data.byteLength < 2 || data.byteLength % 2 !== 0) return;

    const samples = new Int16Array(data);
    const audioBuffer = context.createBuffer(
      1,
      samples.length,
      24000,
    );

    const channel = audioBuffer.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 32768;
    }

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);

    playbackNodesRef.current.add(source);

    source.onended = () => {
      playbackNodesRef.current.delete(source);
      source.disconnect();
    };

    const startAt = Math.max(
      context.currentTime,
      playbackCursorRef.current,
    );

    playbackCursorRef.current = startAt + audioBuffer.duration;
    source.start(startAt);
  }, []);

  const handleServerEvent = useCallback(
    (event: LiveServerEvent) => {
      switch (event.type) {
        case "ready":
          setConnected(true);
          setStatus("Connected — speak naturally");
          break;

        case "input_transcription":
          if (event.text) {
            userTranscriptRef.current += event.text;
            setUserCaption(userTranscriptRef.current);
          }
          break;

        case "output_transcription":
          if (event.text) {
            assistantTranscriptRef.current += event.text;
            setAssistantCaption(assistantTranscriptRef.current);
            setStatus("Gemini is responding");
          }
          break;

        case "interrupted":
          clearPlayback();
          assistantTranscriptRef.current = "";
          setAssistantCaption("");
          setStatus("Listening — you can speak");
          break;

        case "turn_complete": {
          const userText = userTranscriptRef.current.trim();
          const assistantText =
            assistantTranscriptRef.current.trim();

          setMessages((current) => {
            const next = [...current];

            if (userText) {
              next.push({ role: "user", content: userText });
            }

            if (assistantText) {
              next.push({
                role: "assistant",
                content: assistantText,
              });
            }

            return next;
          });

          userTranscriptRef.current = "";
          assistantTranscriptRef.current = "";
          setUserCaption("");
          setAssistantCaption("");
          setStatus("Connected — speak naturally");
          break;
        }

        case "error":
          setError(event.message || "The live session failed.");
          setStatus("Connection error");
          break;
      }
    },
    [clearPlayback],
  );

  const startLive = useCallback(async () => {
    if (startInProgressRef.current || connected) return;

    startInProgressRef.current = true;
    manuallyStoppingRef.current = false;
    setError("");
    setStatus("Requesting microphone access...");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is unavailable. Open the app in a supported browser on localhost or HTTPS.",
        );
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const context = new AudioContext();
      contextRef.current = context;
      await context.resume();

      setStatus("Connecting to Gemini Live...");

      const socket = new WebSocket(LIVE_URL);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onmessage = (message: MessageEvent) => {
        if (message.data instanceof ArrayBuffer) {
          void playAudioChunk(message.data).catch((err: unknown) => {
            setError(
              err instanceof Error
                ? err.message
                : "Unable to play live audio.",
            );
          });
          return;
        }

        if (typeof message.data === "string") {
          try {
            handleServerEvent(
              JSON.parse(message.data) as LiveServerEvent,
            );
          } catch {
            setError("Received an invalid message from the backend.");
          }
        }
      };

      socket.onerror = () => {
        setError(
          "Could not connect to the Live API. Check FastAPI and the backend terminal.",
        );
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          releaseMedia();
          setConnected(false);
          setStatus("Disconnected");

          if (!manuallyStoppingRef.current) {
            setError(
              "The live connection closed. Check the backend terminal for details.",
            );
          }
        }
      };

      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("Timed out while connecting to Gemini Live."));
        }, 15000);

        socket.addEventListener(
          "open",
          () => {
            window.clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );

        socket.addEventListener(
          "error",
          () => {
            window.clearTimeout(timeout);
            reject(new Error("The live WebSocket connection failed."));
          },
          { once: true },
        );

        socket.addEventListener(
          "close",
          () => {
            window.clearTimeout(timeout);
            reject(new Error("The live connection closed before setup."));
          },
          { once: true },
        );
      });

      const inputSource = context.createMediaStreamSource(stream);
      inputSourceRef.current = inputSource;

      // ScriptProcessorNode is broadly supported, though deprecated.
      // It keeps this first version simple; AudioWorklet can replace it later.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const muteGain = context.createGain();
      muteGain.gain.value = 0;
      muteGainRef.current = muteGain;

      processor.onaudioprocess = (audioEvent) => {
        if (socket.readyState !== WebSocket.OPEN) return;

        const samples = audioEvent.inputBuffer.getChannelData(0);
        const pcm = convertToPcm16(samples, context.sampleRate);

        if (pcm.byteLength > 0) {
          socket.send(pcm);
        }
      };

      inputSource.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(context.destination);

      setStatus("Microphone ready — connecting to session...");
    } catch (err) {
      releaseMedia();

      const socket = socketRef.current;
      socketRef.current = null;

      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }

      setConnected(false);
      setStatus("Not connected");
      setError(
        err instanceof Error
          ? err.message
          : "Could not start live voice.",
      );
    } finally {
      startInProgressRef.current = false;
    }
  }, [
    connected,
    handleServerEvent,
    playAudioChunk,
    releaseMedia,
  ]);

  useEffect(() => {
    return () => {
      manuallyStoppingRef.current = true;

      const socket = socketRef.current;
      socketRef.current = null;

      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }

      if (processorRef.current) {
        processorRef.current.onaudioprocess = null;
        processorRef.current.disconnect();
      }

      inputSourceRef.current?.disconnect();
      muteGainRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((track) => track.stop());

      for (const node of playbackNodesRef.current) {
        try {
          node.stop();
        } catch {
          // The node may already have stopped.
        }
      }

      const context = contextRef.current;

      if (context && context.state !== "closed") {
        void context.close();
      }
    };
  }, []);

  return (
    <main className="live-page">
      <header className="topbar">
        <a className="back-link" href="/">
          ← Text chat
        </a>
        <span className="brand">✳ My AI Voice</span>
        <span className={`connection ${connected ? "online" : ""}`}>
          <span className="connection-dot" />
          {connected ? "Live session" : "Offline"}
        </span>
      </header>

      <section className="main-panel">
        <div className="hero">
          <p className="eyebrow">GEMINI LIVE</p>
          <h1>Talk naturally.</h1>
          <p className="subtitle">
            Speak normally and hear Gemini respond in real time.
            Your microphone stays active during the live session.
          </p>

          <div className={`orb ${connected ? "orb-active" : ""}`}>
            <span className="orb-inner">✳</span>
          </div>

          <p className="status" role="status">
            {status}
          </p>

          <div className="controls">
            {!connected ? (
              <button
                className="start-button"
                onClick={() => void startLive()}
                disabled={startInProgressRef.current}
              >
                Start live conversation
              </button>
            ) : (
              <button
                className="stop-button"
                onClick={stopLive}
              >
                Stop conversation
              </button>
            )}
          </div>

          <p className="privacy-note">
            Your browser streams microphone audio to your local backend,
            which forwards it to Gemini. Use headphones to reduce echo.
          </p>
        </div>

        {error && (
          <div className="error-box" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        <section className="captions" aria-label="Live captions">
          {userCaption && (
            <div className="caption-card">
              <span className="caption-label">YOU</span>
              <p>{userCaption}</p>
            </div>
          )}

          {assistantCaption && (
            <div className="caption-card assistant-caption">
              <span className="caption-label">GEMINI</span>
              <p>{assistantCaption}</p>
            </div>
          )}
        </section>

        <section className="history">
          <h2>Conversation transcript</h2>
          {messages.length === 0 ? (
            <p className="empty-history">
              Your conversation will appear here after you speak.
            </p>
          ) : (
            messages.map((message, index) => (
              <article
                key={`${index}-${message.role}`}
                className={`history-message ${message.role}`}
              >
                <strong>
                  {message.role === "user" ? "You" : "Gemini"}
                </strong>
                <p>{message.content}</p>
              </article>
            ))
          )}
        </section>
      </section>

      <style jsx>{`
        .live-page {
          min-height: 100vh;
          background: #0c0d12;
          color: #f5f5f7;
          font-family: Arial, Helvetica, sans-serif;
        }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 20px clamp(16px, 4vw, 52px);
          border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        }

        .back-link {
          color: #b7b7c8;
          font-size: 13px;
          text-decoration: none;
        }

        .back-link:hover {
          color: #fff;
        }

        .brand {
          font-size: 14px;
          font-weight: 600;
        }

        .connection {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: #a4a4b6;
          font-size: 12px;
        }

        .connection-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #737383;
        }

        .online .connection-dot {
          background: #4ade80;
          box-shadow: 0 0 12px rgba(74, 222, 128, 0.5);
        }

        .main-panel {
          width: min(760px, calc(100% - 32px));
          margin: 0 auto;
          padding: 54px 0 60px;
        }

        .hero {
          display: flex;
          align-items: center;
          flex-direction: column;
          text-align: center;
        }

        .eyebrow {
          margin: 0 0 14px;
          color: #aaa0ff;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.19em;
        }

        h1 {
          margin: 0;
          font-size: clamp(34px, 6vw, 52px);
          font-weight: 600;
          letter-spacing: -0.045em;
        }

        .subtitle {
          max-width: 440px;
          margin: 15px 0 0;
          color: #a8a8b9;
          font-size: 14px;
          line-height: 1.8;
        }

        .orb {
          display: grid;
          place-items: center;
          width: 154px;
          height: 154px;
          margin: 42px 0 25px;
          border: 1px solid rgba(169, 153, 255, 0.22);
          border-radius: 50%;
          background:
            radial-gradient(circle at 30% 25%, rgba(168, 126, 255, 0.3), transparent 48%),
            radial-gradient(circle at 70% 80%, rgba(67, 130, 255, 0.24), transparent 48%),
            #171624;
          box-shadow: 0 0 70px rgba(127, 90, 240, 0.12);
          transition: box-shadow 180ms ease, transform 180ms ease;
        }

        .orb-active {
          animation: orb-pulse 2s ease-in-out infinite;
          box-shadow: 0 0 80px rgba(127, 90, 240, 0.3);
        }

        .orb-inner {
          display: grid;
          place-items: center;
          width: 82px;
          height: 82px;
          border-radius: 50%;
          background: linear-gradient(145deg, #b2a2ff, #6a5ad8);
          color: white;
          font-size: 38px;
          box-shadow: 0 0 30px rgba(157, 130, 255, 0.35);
        }

        .status {
          min-height: 20px;
          margin: 0;
          color: #c0bfd2;
          font-size: 13px;
        }

        .controls {
          margin-top: 23px;
        }

        .start-button,
        .stop-button {
          min-height: 46px;
          padding: 0 23px;
          border: 1px solid transparent;
          border-radius: 13px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 160ms ease, opacity 160ms ease;
        }

        .start-button {
          background: #a99aff;
          color: #13111e;
        }

        .stop-button {
          border-color: rgba(255, 255, 255, 0.18);
          background: #24232f;
          color: #fff;
        }

        .start-button:hover,
        .stop-button:hover {
          transform: translateY(-1px);
        }

        .start-button:disabled {
          opacity: 0.6;
          cursor: wait;
        }

        .privacy-note {
          max-width: 430px;
          margin: 19px 0 0;
          color: #777789;
          font-size: 11px;
          line-height: 1.7;
        }

        .error-box {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin: 28px 0 0;
          padding: 14px 16px;
          border: 1px solid rgba(248, 113, 113, 0.3);
          border-radius: 12px;
          background: rgba(127, 29, 29, 0.18);
          color: #fca5a5;
          font-size: 13px;
          line-height: 1.7;
        }

        .error-box button {
          border: 0;
          background: transparent;
          color: inherit;
          font-size: 20px;
          cursor: pointer;
        }

        .captions {
          display: grid;
          gap: 10px;
          margin-top: 34px;
        }

        .caption-card {
          padding: 16px 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 13px;
          background: rgba(255, 255, 255, 0.035);
          text-align: left;
        }

        .assistant-caption {
          border-color: rgba(169, 154, 255, 0.2);
          background: rgba(124, 101, 255, 0.06);
        }

        .caption-label {
          color: #aaa0ff;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.15em;
        }

        .caption-card p {
          margin: 8px 0 0;
          color: #e4e4ed;
          font-size: 13px;
          line-height: 1.7;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .history {
          margin-top: 40px;
          padding-top: 26px;
          border-top: 1px solid rgba(255, 255, 255, 0.09);
        }

        .history h2 {
          margin: 0 0 18px;
          font-size: 15px;
          font-weight: 600;
        }

        .empty-history {
          color: #88889a;
          font-size: 12px;
        }

        .history-message {
          margin-bottom: 13px;
          padding: 15px 17px;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.025);
        }

        .history-message strong {
          color: #b9adff;
          font-size: 11px;
        }

        .history-message p {
          margin: 7px 0 0;
          color: #dfdfe8;
          font-size: 13px;
          line-height: 1.7;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .history-message.user strong {
          color: #86c8ff;
        }

        @keyframes orb-pulse {
          0%, 100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.04);
          }
        }

        @media (max-width: 600px) {
          .topbar {
            flex-wrap: wrap;
          }

          .brand {
            order: -1;
            width: 100%;
          }

          .main-panel {
            padding-top: 38px;
          }

          .orb {
            width: 130px;
            height: 130px;
            margin-top: 34px;
          }

          .orb-inner {
            width: 70px;
            height: 70px;
            font-size: 32px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .orb-active {
            animation: none;
          }

          .start-button,
          .stop-button {
            transition: none;
          }
        }
      `}</style>
    </main>
  );
}
