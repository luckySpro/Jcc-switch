import { useEffect, useRef } from "react";

/** 粘贴的文本像 Key 或带 Key 的配置 */
export function looksLikeKeyPaste(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 16 || trimmed.length > 8000) return false;
  return /[A-Za-z0-9][A-Za-z0-9._-]{15,}/.test(trimmed) && /\d/.test(trimmed);
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * 在主界面空白处按 Ctrl/⌘+V 粘贴 Key 时打开一键添加。
 * 焦点在输入框或已有对话框打开时不拦截。
 */
export function usePasteToQuickAdd(onPaste: (text: string) => void) {
  const handler = useRef(onPaste);
  handler.current = onPaste;

  useEffect(() => {
    const listener = (event: ClipboardEvent) => {
      if (isEditable(event.target) || isEditable(document.activeElement))
        return;
      if (document.querySelector('[role="dialog"]')) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!looksLikeKeyPaste(text)) return;
      event.preventDefault();
      handler.current(text);
    };
    window.addEventListener("paste", listener);
    return () => window.removeEventListener("paste", listener);
  }, []);
}
