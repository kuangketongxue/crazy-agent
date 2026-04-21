"use client";

import { useEffect } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import ChatApp from "@/components/chat-app";

export default function WorkspacePage() {
  const { isLoaded, userId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;
    if (!userId) {
      router.replace("/sign-in");
    }
  }, [isLoaded, userId, router]);

  if (!isLoaded || !userId) {
    return (
      <div className="auth-shell" style={{ placeItems: "center" }}>
        <div className="card" style={{ padding: 16, color: "#d8e7ff" }}>
          正在进入工作台...
        </div>
      </div>
    );
  }

  return <ChatApp />;
}
