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
import { runAppleScript } from "@raycast/utils";
import { PROVIDERS, proofread, toProviderId } from "./providers";
import type { ProofreadOptions, ProviderId } from "./providers/types";
import { asProviderError, type ProviderError } from "./lib/errors";

/** Refuse selections larger than this so a truncated paste can't clobber them. */
const MAX_INPUT_CHARS = 10_000;

/** How the corrected text replaces the selection (the pasteMode preference). */
type PasteMode = "plain" | "normal" | "copy";

/** Resolve global preferences into core options (proofread adds no per-command prefs). */
function resolveOptions(formal: boolean): ProofreadOptions {
  const prefs = getPreferenceValues<Preferences>();
  const language = (prefs.outputLanguage ?? "").trim();
  const provider = toProviderId(prefs.provider);
  const openai = provider === "openai";
  const apiKey = openai ? prefs.openaiApiKey : prefs.apiKey;
  const model = openai ? prefs.openaiModel : prefs.model;
  return {
    provider,
    apiKey: (apiKey ?? "").trim(),
    model: (model ?? "").trim() || PROVIDERS[provider].defaultModel,
    formal,
    outputLanguage: /^auto$/i.test(language)
      ? undefined
      : language || undefined,
  };
}

function resolvePasteMode(): PasteMode {
  const mode = getPreferenceValues<Preferences>().pasteMode;
  return mode === "normal" || mode === "copy" ? mode : "plain";
}

/**
 * Paste over the selection. In "plain" mode: copy the string and send
 * Shift+Cmd+V ("Paste and Match Style") so rich-text apps (Teams, Slack) don't
 * inject blank lines between the pasted lines. That keystroke needs
 * Accessibility permission for Raycast — if it fails, fall back to the normal
 * rich paste so the run still completes.
 */
async function pasteResult(text: string, mode: PasteMode): Promise<string> {
  if (mode === "plain") {
    await Clipboard.copy(text);
    try {
      await runAppleScript(
        'tell application "System Events" to keystroke "v" using {command down, shift down}',
      );
      // Some apps bind ⇧⌘V to something else — the clipboard is the backup.
      return "✅ Proofread — pasted via ⇧⌘V (also on clipboard)";
    } catch {
      // Accessibility not granted (or the keystroke failed) — rich paste instead.
      await Clipboard.paste(text);
      return "✅ Proofread — pasted; allow Accessibility for plain paste";
    }
  }
  await Clipboard.paste(text);
  return "✅ Proofread — pasted in place";
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
function hudForError(error: ProviderError, provider: ProviderId): string {
  const { label } = PROVIDERS[provider];
  switch (error.kind) {
    case "empty":
      return "⚠️ Nothing to proofread — select some text or copy it first";
    case "auth":
      return provider === "openai"
        ? "⚠️ Set your OpenAI API key in the extension preferences, or switch Provider to Gemini"
        : "⚠️ Set your Gemini API key in the extension preferences";
    case "rateLimit":
      return "⚠️ Rate limit — wait a few seconds and try again";
    case "timeout":
      return `⚠️ ${label} timed out — try again`;
    case "network":
      return `⚠️ No connection to ${label}`;
    case "parse":
      return `⚠️ ${label} returned an empty response — try again`;
    case "api":
      return `⚠️ ${label} error — check the extension and try again`;
  }
}

/** Entry point shared by both no-view commands. */
export async function runProofread(formal: boolean): Promise<void> {
  const label = formal ? "Proofread Formal" : "Proofread";
  const options = resolveOptions(formal);
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
    const { text: corrected } = await proofread(core, options);

    const mode = resolvePasteMode();
    if (fromSelection && mode !== "copy") {
      // Re-apply the selection's original surrounding whitespace before pasting.
      const hud = await pasteResult(lead + corrected + trail, mode);
      await showHUD(hud);
    } else {
      await Clipboard.copy(corrected);
      await showHUD("✅ Proofread — copied to clipboard");
    }
  } catch (caught) {
    const error = asProviderError(caught);
    await showHUD(hudForError(error, options.provider));
    if (error.kind === "auth") {
      await openExtensionPreferences();
    }
  }
}
