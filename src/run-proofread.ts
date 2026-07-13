/**
 * The no-view command runner: proofread the SELECTED text in place, with no
 * window. On the hotkey it grabs the current selection (falling back to the
 * clipboard), fixes it, and pastes the corrected version back over the
 * selection — the whole interaction is a single HUD line.
 *
 * Both the casual and the formal no-view commands call this with a `formal` flag.
 *
 * Two safeguards beyond a naive replace: the selection's leading/trailing
 * whitespace is captured and re-applied around the corrected text (the model
 * only ever sees the trimmed core), and an input longer than MAX_INPUT_CHARS is
 * refused up front so a truncated response can never be pasted over a big
 * selection.
 */

import {
  Clipboard,
  getPreferenceValues,
  getSelectedText,
  openExtensionPreferences,
  showHUD,
} from "@raycast/api";
import { DEFAULT_MODEL, proofread } from "./providers";
import type { ProofreadOptions } from "./providers/types";
import { asProviderError, type ProviderError } from "./lib/errors";

/** Refuse selections larger than this so a truncated paste can't clobber them. */
const MAX_INPUT_CHARS = 10_000;

/** Resolve global preferences into core options (proofread adds no per-command prefs). */
function resolveOptions(formal: boolean): ProofreadOptions {
  const prefs = getPreferenceValues<Preferences>();
  return {
    apiKey: (prefs.apiKey ?? "").trim(),
    model: (prefs.model ?? "").trim() || DEFAULT_MODEL,
    formal,
  };
}

/**
 * Read the text to proofread: prefer the current selection so the result can be
 * pasted back in place; fall back to the clipboard when nothing is selected
 * (getSelectedText throws when there is no selection). The raw text is returned
 * untrimmed so the caller can preserve its surrounding whitespace.
 */
async function readInput(): Promise<{ text: string; fromSelection: boolean }> {
  try {
    const selected = await getSelectedText();
    if (selected.trim() !== "") {
      return { text: selected, fromSelection: true };
    }
  } catch {
    // No selection / the app doesn't expose one — fall through to the clipboard.
  }
  const clip = (await Clipboard.readText()) ?? "";
  return { text: clip, fromSelection: false };
}

/** Short, human HUD message for a failed run. */
function hudForError(error: ProviderError): string {
  switch (error.kind) {
    case "empty":
      return "⚠️ Nothing to proofread — select some text or copy it first";
    case "auth":
      return "⚠️ Set your Gemini API key in the extension preferences";
    case "rateLimit":
      return "⚠️ Rate limit — wait a few seconds and try again";
    case "timeout":
      return "⚠️ Gemini timed out — try again";
    case "network":
      return "⚠️ No connection to Gemini";
    case "parse":
      return "⚠️ Gemini returned an empty response — try again";
    case "api":
      return "⚠️ Gemini error — check the extension and try again";
  }
}

/** Entry point shared by both no-view commands. */
export async function runProofread(formal: boolean): Promise<void> {
  const label = formal ? "Proofread Formal" : "Proofread";
  try {
    const { text: rawInput, fromSelection } = await readInput();

    // Split off the surrounding whitespace; only the trimmed core is proofread.
    const lead = rawInput.match(/^\s*/)?.[0] ?? "";
    const trail = rawInput.match(/\s*$/)?.[0] ?? "";
    const core = rawInput.slice(lead.length, rawInput.length - trail.length);

    if (core === "") {
      await showHUD(
        "⚠️ Nothing to proofread — select some text or copy it first",
      );
      return;
    }
    if (core.length > MAX_INPUT_CHARS) {
      await showHUD(
        `⚠️ Selection too long (${core.length} chars, max ${MAX_INPUT_CHARS})`,
      );
      return;
    }

    await showHUD(`${label}…`);
    const { text: corrected } = await proofread(core, resolveOptions(formal));

    if (fromSelection) {
      // Re-apply the selection's original surrounding whitespace before pasting.
      await Clipboard.paste(lead + corrected + trail);
      await showHUD("✅ Proofread — pasted in place");
    } else {
      await Clipboard.copy(corrected);
      await showHUD("✅ Proofread — copied to clipboard");
    }
  } catch (caught) {
    const error = asProviderError(caught);
    await showHUD(hudForError(error));
    if (error.kind === "auth") {
      await openExtensionPreferences();
    }
  }
}
