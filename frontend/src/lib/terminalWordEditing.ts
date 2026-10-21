/** Readline/Emacs word commands; word boundaries remain owned by the shell. */
const WORD_KEYS: Readonly<Record<string, string>> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
  Backspace: "\x1b\x7f",
  Delete: "\x1bd",
};

export function terminalWordEditingInput(
  event: Pick<KeyboardEvent, "type" | "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "keyCode" | "getModifierState">,
  options: { enabled: boolean; alternateActive: boolean; hotkeyMatched: boolean },
): string | undefined {
  if (!options.enabled || options.alternateActive || options.hotkeyMatched) return;
  if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState("AltGraph")) return;
  return Object.hasOwn(WORD_KEYS, event.key) ? WORD_KEYS[event.key] : undefined;
}

/** The append-only suggestion model cannot follow shell-owned word edits.
 * Keep it suppressed until a new line; do not guess a remote shell's cursor.
 */
export function wordEditingLineUntrusted(previous: boolean, data: string): boolean {
  if (/[\r\n\x03]/.test(data)) return false;
  return previous || Object.values(WORD_KEYS).includes(data);
}
