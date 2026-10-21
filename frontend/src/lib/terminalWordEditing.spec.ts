import { describe, expect, it } from "vitest";
import { terminalWordEditingInput, wordEditingLineUntrusted } from "./terminalWordEditing";

const event = (key: string, patch = {}) => ({
  type: "keydown", key, altKey: true, ctrlKey: false, metaKey: false,
  shiftKey: false, isComposing: false, keyCode: 0,
  getModifierState: () => false, ...patch,
});
const options = { enabled: true, alternateActive: false, hotkeyMatched: false };

describe("Alt/Option word editing", () => {
  it.each([
    ["ArrowLeft", "\x1bb"], ["ArrowRight", "\x1bf"],
    ["Backspace", "\x1b\x7f"], ["Delete", "\x1bd"],
  ])("maps %s, including key repeats", (key, bytes) => {
    expect(terminalWordEditingInput(event(key), options)).toBe(bytes);
    expect(terminalWordEditingInput(event(key, { repeat: true }), options)).toBe(bytes);
  });

  it.each([
    { altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { isComposing: true }, { keyCode: 229 }, { type: "keyup" },
    { getModifierState: (key: string) => key === "AltGraph" },
  ])("preserves other modifiers and composition: %j", patch => {
    expect(terminalWordEditingInput(event("ArrowLeft", patch), options)).toBeUndefined();
  });

  it.each([
    { enabled: false }, { alternateActive: true }, { hotkeyMatched: true },
  ])("preserves opt-out, full-screen input and user hotkeys: %j", patch => {
    expect(terminalWordEditingInput(event("ArrowLeft"), { ...options, ...patch })).toBeUndefined();
  });

  it.each(["ArrowUp", "ArrowDown", "b", "f", "Dead", "toString"])("leaves %s untouched", key => {
    expect(terminalWordEditingInput(event(key), options)).toBeUndefined();
  });

  it("keeps stale suggestions suppressed through further typing until a new line", () => {
    for (const data of ["\x1bb", "\x1bf", "\x1b\x7f", "\x1bd"]) {
      expect(wordEditingLineUntrusted(false, data)).toBe(true);
    }
    for (const data of ["x", "\x7f", "\t", "\x1b[C"]) {
      expect(wordEditingLineUntrusted(true, data)).toBe(true);
    }
    for (const data of ["\r", "\n", "\x03"]) {
      expect(wordEditingLineUntrusted(true, data)).toBe(false);
    }
    expect(wordEditingLineUntrusted(false, "x")).toBe(false);
  });
});
