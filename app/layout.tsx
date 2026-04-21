import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { readOptionalClerkPublishableKey } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crazy Agent",
  description: "个人 AI Agent 网站",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const publishableKey = readOptionalClerkPublishableKey();

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <html lang="zh-CN">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
