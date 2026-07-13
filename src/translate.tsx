import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  getPreferenceValues,
  openExtensionPreferences,
  useNavigation,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useEffect, useState } from "react";
import { DEFAULT_MODEL, translate } from "./providers";
import type { TranslateOptions, TranslateResult } from "./providers/types";
import {
  ProviderError,
  type ProviderErrorKind,
  asProviderError,
} from "./lib/errors";

const API_KEY_URL = "https://aistudio.google.com/app/apikey";

/** Resolve preferences (manifest -> raycast-env.d.ts) into core options. */
function resolveOptions(): TranslateOptions {
  const prefs = getPreferenceValues<Preferences.Translate>();
  return {
    apiKey: (prefs.apiKey ?? "").trim(),
    model: (prefs.model ?? "").trim() || DEFAULT_MODEL,
    explanationLanguage: (prefs.explanationLanguage ?? "").trim() || "Russian",
    alwaysExplain: Boolean(prefs.alwaysExplain),
  };
}

/**
 * Defang markdown images in model-derived text before rendering. Detail loads
 * `![](url)` images automatically, which would beacon out to a URL the model
 * (i.e. arbitrary input) can choose. Escaping `![` turns it into a plain,
 * click-only link instead of an auto-loaded image.
 */
function defangImages(markdown: string): string {
  return markdown.replace(/!\[/g, "\\![");
}

type ViewState =
  | { status: "loading" }
  | { status: "ok"; result: TranslateResult }
  | { status: "error"; error: ProviderError };

function composeResult(result: TranslateResult): string {
  return result.explanation
    ? `${result.translation}\n\n---\n\n${result.explanation}`
    : result.translation;
}

function errorTitle(error: ProviderError): string {
  switch (error.kind) {
    case "empty":
      return "Empty input";
    case "auth":
      return "Gemini API key required";
    case "rateLimit":
      return "Rate limit";
    case "timeout":
      return "Timed out";
    case "network":
      return "No connection";
    case "parse":
      return "Empty model response";
    case "api":
      return "API error";
  }
}

const ERROR_HINTS: Record<ProviderErrorKind, string> = {
  empty: "Enter some text and try again.",
  auth: `A Gemini API key is required — it's **free**: get one at [aistudio.google.com](${API_KEY_URL}) (Get API key) and paste it into the extension preferences.`,
  rateLimit: "Too many requests. Wait a few seconds and try again.",
  timeout:
    "Gemini did not respond within 30 seconds. Check your connection or try again.",
  network: "Could not reach Gemini. Check your internet connection.",
  parse: "Gemini returned an empty or unreadable response. Try again.",
  api: "Gemini returned an error. Details below.",
};

function errorMarkdown(error: ProviderError): string {
  const lines = [`# ⚠️ ${errorTitle(error)}`, "", ERROR_HINTS[error.kind]];
  // Only the generic "api" kind carries extra info beyond the hint (the HTTP status).
  if (error.kind === "api") {
    lines.push("", "```", error.message, "```");
  }
  return lines.join("\n");
}

/** Result screen: the request runs in useEffect; states are loading/ok/error. */
function ResultView({ input }: { input: string }) {
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: "loading" });

    (async () => {
      try {
        const result = await translate(input, {
          ...resolveOptions(),
          signal: controller.signal,
        });
        if (!cancelled) {
          setState({ status: "ok", result });
        }
      } catch (raw) {
        if (cancelled) {
          return;
        }
        const error = asProviderError(raw);
        setState({ status: "error", error });
        void showFailureToast(error, { title: errorTitle(error) });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [input]);

  if (state.status === "loading") {
    const quoted = defangImages(input).replace(/\n/g, "\n> ");
    return (
      <Detail
        isLoading
        navigationTitle="Polyglot"
        markdown={`> ${quoted}\n\n_Translating…_`}
      />
    );
  }

  if (state.status === "error") {
    const { error } = state;
    return (
      <Detail
        navigationTitle="Polyglot — error"
        markdown={errorMarkdown(error)}
        actions={
          <ActionPanel>
            <Action
              title="Open Extension Preferences"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
            {error.kind === "auth" && (
              <Action.OpenInBrowser
                title="Get a Free Key (AI Studio)"
                url={API_KEY_URL}
                icon={Icon.Key}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Error Text"
              content={error.message}
            />
          </ActionPanel>
        }
      />
    );
  }

  const { result } = state;
  const composed = composeResult(result);
  return (
    <Detail
      navigationTitle="Polyglot"
      markdown={defangImages(composed)}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Result" content={composed} />
          <Action.CopyToClipboard
            title="Copy Translation Only"
            content={result.translation}
          />
          <Action
            title="Open Extension Preferences"
            icon={Icon.Gear}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    />
  );
}

/** Command: the input form -> pushes the result screen. */
export default function Command() {
  const { push } = useNavigation();
  const [error, setError] = useState<string | undefined>();

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Translate"
            icon={Icon.Globe}
            onSubmit={(values: { text: string }) => {
              const text = (values.text ?? "").trim();
              if (text === "") {
                setError("Enter some text");
                return;
              }
              push(<ResultView input={text} />);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="text"
        title="Text"
        placeholder="Type text in Russian or English — the direction is detected automatically…"
        autoFocus
        error={error}
        onChange={() => {
          if (error) {
            setError(undefined);
          }
        }}
      />
    </Form>
  );
}
