
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My AI Voice",
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
