import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";
import { PROVIDERS, explain, toProviderId, translate } from "./providers";
import type {
  ExplainResult,
  ProviderId,
  TranslateOptions,
  TranslateProgress,
  TranslateResult,
} from "./providers/types";
import { ProviderError, asProviderError } from "./lib/errors";
import { defangImages } from "./lib/markdown";

/** How the explanation block arrives (the explanationMode preference). */
type Mode = "stream" | "all" | "onDemand";

/** At most one streamed re-render per this many ms (ESTIMATE, not measured). */
const RENDER_MS = 100;

/** Resolve preferences (manifest -> raycast-env.d.ts) into core options. */
function resolveOptions(): TranslateOptions {
  const prefs = getPreferenceValues<Preferences.Translate>();
  const provider = toProviderId(prefs.provider);
  const openai = provider === "openai";
  const apiKey = openai ? prefs.openaiApiKey : prefs.apiKey;
  const model = openai ? prefs.openaiModel : prefs.model;
  return {
    provider,
    apiKey: (apiKey ?? "").trim(),
    model: (model ?? "").trim() || PROVIDERS[provider].defaultModel,
    explanationLanguage: (prefs.explanationLanguage ?? "").trim() || "Russian",
    alwaysExplain: Boolean(prefs.alwaysExplain),
  };
}

function resolveMode(): Mode {
  const mode = getPreferenceValues<Preferences.Translate>().explanationMode;
  return mode === "all" || mode === "onDemand" ? mode : "stream";
}

/** Coalesce rapid stream updates into one re-render per `ms`. */
function createThrottle<T>(apply: (value: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const latest: { value?: T } = {};
  return {
    push(value: T) {
      latest.value = value;
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          apply(latest.value as T);
        }, ms);
      }
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

type ViewState =
  | { status: "loading" }
  | { status: "streaming"; progress: TranslateProgress }
  | { status: "ok"; result: TranslateResult; failure?: ProviderError }
  | { status: "error"; error: ProviderError };

/**
 * The on-demand explain request (second request, fired by Enter). Its result
 * is kept here, apart from the translation's, so neither cutShort overwrites
 * the other.
 */
type ExplainState =
  | { status: "idle" }
  | { status: "running"; partial: string }
  | { status: "error"; error: ProviderError; partial: string }
  | { status: "done"; result: ExplainResult };

const SEPARATOR = "\n\n---\n\n";
const EXPLAINING = "_Explaining…_";
const HINT = "_Press **↵ Enter** to explain this translation._";

/** What the copy action puts on the clipboard (no notes, no hints). */
function composeResult(translation: string, explanation: string | null) {
  return explanation ? `${translation}${SEPARATOR}${explanation}` : translation;
}

function errorTitle(error: ProviderError, provider: ProviderId): string {
  switch (error.kind) {
    case "empty":
      return "Empty input";
    case "auth":
      return `${PROVIDERS[provider].label} API key required`;
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

function errorHint(error: ProviderError, provider: ProviderId): string {
  const { label, keyUrl } = PROVIDERS[provider];
  switch (error.kind) {
    case "empty":
      return "Enter some text and try again.";
    case "auth":
      return provider === "openai"
        ? `An OpenAI API key is required — create one at [platform.openai.com/api-keys](${keyUrl}) and paste it into the extension preferences, or switch **Provider** to Gemini.`
        : `A Gemini API key is required — it's **free**: get one at [aistudio.google.com](${keyUrl}) (Get API key) and paste it into the extension preferences.`;
    case "rateLimit":
      return "Too many requests. Wait a few seconds and try again.";
    case "timeout":
      return `${label} stopped sending data (it gets up to 60 s for the first data, then 30 s between chunks). Check your connection or try again.`;
    case "network":
      return `Could not reach ${label}. Check your internet connection.`;
    case "parse":
      return `${label} returned an empty or unreadable response. Try again.`;
    case "api":
      return `${label} returned an error. Details below.`;
  }
}

function errorMarkdown(error: ProviderError, provider: ProviderId): string {
  const lines = [
    `# ⚠️ ${errorTitle(error, provider)}`,
    "",
    errorHint(error, provider),
  ];
  // Only the generic "api" kind carries extra info beyond the hint (the HTTP status).
  if (error.kind === "api") {
    lines.push("", "```", error.message, "```");
  }
  return lines.join("\n");
}

/** One-line inline note for a failure before any of its text arrived. */
function failureNote(error: ProviderError, provider: ProviderId): string {
  return `_⚠️ ${errorTitle(error, provider)}: ${error.message}_`;
}

/** Inline note for a failure after some text is on screen: that text is partial. */
function interruptedNote(error: ProviderError): string {
  return `_⚠️ ${error.message} The text above is incomplete._`;
}

/** `what` names the cut part: "Translation", "Explanation" or "Response". */
function cutShortNote(what: string, reason: string): string {
  return `_⚠️ ${what} cut short (${reason}) — the text above may be incomplete._`;
}

/** Join the non-empty markdown pieces with blank lines. */
function joinParts(parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n\n");
}

/** What goes under the translation in on-demand mode. */
function explainTail(explaining: ExplainState, provider: ProviderId): string {
  switch (explaining.status) {
    case "idle":
      return HINT;
    case "running":
      return explaining.partial || EXPLAINING;
    case "error":
      return joinParts([
        explaining.partial,
        explaining.partial === ""
          ? failureNote(explaining.error, provider)
          : interruptedNote(explaining.error),
        "_Press **↵ Enter** to retry._",
      ]);
    case "done": {
      const { explanation, cutShort } = explaining.result;
      return joinParts([
        explanation,
        cutShort ? cutShortNote("Explanation", cutShort) : "",
      ]);
    }
  }
}

/** A placeholder action: keeps its slot (↵ / ⌘↵) and only explains why not yet. */
function NotYetAction(props: { title: string; icon: Icon; message: string }) {
  return (
    <Action
      title={props.title}
      icon={props.icon}
      onAction={() =>
        void showToast({ style: Toast.Style.Failure, title: props.message })
      }
    />
  );
}

/** Result screen: the request runs in useEffect; see ViewState for the states. */
function ResultView({ input }: { input: string }) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [explaining, setExplaining] = useState<ExplainState>({
    status: "idle",
  });
  const explainAbort = useRef<AbortController | undefined>(undefined);
  const [mode] = useState(resolveMode);
  const [provider] = useState(() => resolveOptions().provider);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const seen: { progress?: TranslateProgress } = {};
    const throttle = createThrottle<TranslateProgress>((progress) => {
      if (!cancelled) {
        setState({ status: "streaming", progress });
      }
    }, RENDER_MS);
    setState({ status: "loading" });

    (async () => {
      try {
        const result = await translate(
          input,
          {
            ...resolveOptions(),
            signal: controller.signal,
            onUpdate: (progress) => {
              seen.progress = progress;
              // All-at-once renders once, at the end.
              if (mode !== "all" && progress.translation !== "") {
                throttle.push(progress);
              }
            },
          },
          mode === "onDemand" ? "translation" : "full",
        );
        throttle.cancel();
        if (!cancelled) {
          setState({ status: "ok", result });
        }
      } catch (raw) {
        throttle.cancel();
        if (cancelled) {
          return;
        }
        const error = asProviderError(raw);
        void showFailureToast(error, { title: errorTitle(error, provider) });
        const shown = seen.progress;
        if (shown && shown.translation !== "") {
          // Keep what arrived (even a partial translation), note the failure.
          const result: TranslateResult = {
            translation: shown.translation,
            explanation: mode === "onDemand" ? null : shown.explanation || null,
            cutShort: null,
          };
          setState({ status: "ok", result, failure: error });
          return;
        }
        setState({ status: "error", error });
      }
    })();

    return () => {
      cancelled = true;
      throttle.cancel();
      controller.abort();
    };
  }, [input, mode, provider]);

  // Leaving the screen aborts an in-flight explain request too.
  useEffect(() => () => explainAbort.current?.abort(), []);

  const runExplain = (translation: string) => {
    explainAbort.current?.abort();
    const controller = new AbortController();
    explainAbort.current = controller;
    const partial = { text: "" };
    const throttle = createThrottle<string>((text) => {
      if (!controller.signal.aborted) {
        setExplaining({ status: "running", partial: text });
      }
    }, RENDER_MS);
    setExplaining({ status: "running", partial: "" });

    (async () => {
      try {
        const result = await explain(input, translation, {
          ...resolveOptions(),
          signal: controller.signal,
          onUpdate: (progress) => {
            partial.text = progress.explanation ?? "";
            throttle.push(partial.text);
          },
        });
        throttle.cancel();
        if (!controller.signal.aborted) {
          setExplaining({ status: "done", result });
        }
      } catch (raw) {
        throttle.cancel();
        if (controller.signal.aborted) {
          return;
        }
        const error = asProviderError(raw);
        setExplaining({ status: "error", error, partial: partial.text });
        void showFailureToast(error, { title: errorTitle(error, provider) });
      }
    })();
  };

  const preferencesAction = (
    <Action
      title="Open Extension Preferences"
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );

  if (state.status === "error") {
    const { error } = state;
    const info = PROVIDERS[provider];
    return (
      <Detail
        navigationTitle="Polyglot — error"
        markdown={errorMarkdown(error, provider)}
        actions={
          <ActionPanel>
            {preferencesAction}
            {error.kind === "auth" && (
              <Action.OpenInBrowser
                title={info.keyAction}
                url={info.keyUrl}
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

  // Every other state keeps the same action slots: ↵ is "Explain" in on-demand
  // mode and "Copy Result" otherwise, ⌘↵ is "Copy Translation Only". While an
  // action can't run yet it stays in its slot and only shows a toast.
  const result = state.status === "ok" ? state.result : undefined;
  const progress = state.status === "streaming" ? state.progress : undefined;
  const translation = result?.translation ?? progress?.translation ?? "";
  const translationFinal =
    result !== undefined || Boolean(progress?.translationDone);

  let markdown: string;
  if (state.status === "loading") {
    const quoted = input.replace(/\n/g, "\n> ");
    markdown = `> ${quoted}\n\n_Translating…_`;
  } else if (progress) {
    const streamingBlock =
      progress.translationDone && mode !== "onDemand"
        ? `${SEPARATOR}${progress.explanation || EXPLAINING}`
        : "";
    markdown = `${progress.translation}${streamingBlock}`;
  } else {
    const notes = joinParts([
      result?.cutShort
        ? cutShortNote(
            mode === "onDemand" ? "Translation" : "Response",
            result.cutShort,
          )
        : "",
      state.status === "ok" && state.failure
        ? interruptedNote(state.failure)
        : "",
    ]);
    markdown =
      mode === "onDemand"
        ? joinParts([
            translation,
            notes,
            `---\n\n${explainTail(explaining, provider)}`,
          ])
        : joinParts([
            composeResult(translation, result?.explanation ?? null),
            notes,
          ]);
  }

  const explained =
    explaining.status === "done" ? explaining.result.explanation : null;
  const copyContent = composeResult(
    translation,
    mode === "onDemand" ? explained : (result?.explanation ?? null),
  );

  const primaryAction = () => {
    if (mode !== "onDemand") {
      return result ? (
        <Action.CopyToClipboard title="Copy Result" content={copyContent} />
      ) : (
        <NotYetAction
          title="Copy Result"
          icon={Icon.Clipboard}
          message="Still translating — wait for the full result"
        />
      );
    }
    if (!result) {
      return (
        <NotYetAction
          title="Explain"
          icon={Icon.Book}
          message="Wait for the translation to finish"
        />
      );
    }
    // A cut-short explanation can be retried; a whole one is final.
    const retry =
      explaining.status === "error" ||
      (explaining.status === "done" && explaining.result.cutShort !== null);
    if (
      explaining.status === "running" ||
      (explaining.status === "done" && !retry)
    ) {
      const message =
        explaining.status === "running"
          ? "Already explaining…"
          : "Already explained";
      return (
        <NotYetAction title="Explain" icon={Icon.Book} message={message} />
      );
    }
    return (
      <Action
        title={retry ? "Retry Explanation" : "Explain"}
        icon={Icon.Book}
        onAction={() => runExplain(result.translation)}
      />
    );
  };

  return (
    <Detail
      isLoading={state.status !== "ok" || explaining.status === "running"}
      navigationTitle="Polyglot"
      markdown={defangImages(markdown)}
      actions={
        <ActionPanel>
          {primaryAction()}
          {translationFinal ? (
            <Action.CopyToClipboard
              title="Copy Translation Only"
              content={translation}
            />
          ) : (
            <NotYetAction
              title="Copy Translation Only"
              icon={Icon.Clipboard}
              message="The translation is still streaming"
            />
          )}
          {mode === "onDemand" && explaining.status === "done" && (
            <Action.CopyToClipboard
              title="Copy Result"
              content={copyContent}
              shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
            />
          )}
          {preferencesAction}
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
