"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { voiceService } from "@/lib/voice-service";

type VoiceButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  voiceText?: string;
  children?: ReactNode;
};

export function VoiceButton({ voiceText, onClick, children, ...rest }: VoiceButtonProps) {
  return (
    <button
      type={rest.type || "button"}
      {...rest}
      onClick={(event) => {
        if (voiceText) {
          voiceService.speak(voiceText);
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
