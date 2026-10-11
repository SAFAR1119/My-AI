
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyVoice AI",
  description: "Your personal AI voice and text assistant.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
