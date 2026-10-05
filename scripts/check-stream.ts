/**
 * Offline checks for the streaming pieces — no key, no network. `fetch` is
 * replaced by a local stub, so every "request" here is answered in-process.
 *
 * Covers: the translate output reader (partial chunks, a chunk boundary inside
 * the mark, missing mark, fences, "no block" words, old JSON replies), the
 * explanation-only reader, the SSE parser (CRLF, multi-line data, comments,
 * [DONE], every split position, UTF-8 split across chunks), both providers'
 * stream folding, the proofread completeness gate, Gemini thinking config and
 * headroom, image defanging, and the first-byte / idle timeouts.
 *
 * Usage: npm run check   (exits non-zero on the first failure)
 */

import assert from "node:assert/strict";
import {
  DEFUSED_MARK,
  EXPLANATION_MARK,
  readExplainOutput,
  readTranslateOutput,
} from "../src/lib/parse";
import { SseParser } from "../src/lib/sse";
import { postStream } from "../src/lib/http";
import { ProviderError } from "../src/lib/errors";
import {
  THINKING_HEADROOM,
  buildBody,
  foldGeminiChunk,
  thinkingFor,
} from "../src/providers/gemini";
import { defangImages } from "../src/lib/markdown";
import {
  buildExplainUserPrompt,
  buildTranslateUserPrompt,
} from "../src/prompts/translate";
import { foldOpenAIEvent } from "../src/providers/openai";
import { proofread, translate } from "../src/providers";
import type { ProviderId, TranslateProgress } from "../src/providers/types";

let passed = 0;

async function check(name: string, body: () => void | Promise<void>) {
  try {
    await body();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exit(1);
  }
}

/** Every prefix of `full`, as the reader sees the buffer while streaming. */
function prefixes(full: string): string[] {
  return Array.from({ length: full.length + 1 }, (_, i) => full.slice(0, i));
}

/** No part of the mark (3+ chars of it) may ever reach the user. */
function assertNoMark(progress: TranslateProgress, raw: string) {
  const shown = `${progress.translation}\n${progress.explanation ?? ""}`;
  assert.ok(
    !shown.includes("<<<"),
    `mark leaked for buffer ${JSON.stringify(raw)}`,
  );
}

// --- fetch stub ----------------------------------------------------------------
type Reply = () => Response;
let nextReply: Reply | undefined;
const realFetch = globalThis.fetch;

function useReply(reply: Reply) {
  nextReply = reply;
  globalThis.fetch = (async () => {
    const make = nextReply;
    assert.ok(make, "unexpected fetch");
    return make();
  }) as typeof fetch;
}

/** An SSE body delivered in small chunks (3 bytes each) to stress boundaries. */
function sseReply(events: string[]): Reply {
  return () => {
    const bytes = new TextEncoder().encode(
      events.map((e) => `data: ${e}\n\n`).join(""),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) {
          controller.enqueue(bytes.slice(i, i + 3));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
}

function translateOpts(
  provider: ProviderId,
  onUpdate?: (p: TranslateProgress) => void,
) {
  return {
    provider,
    apiKey: "test-key",
    model: provider === "openai" ? "gpt-6-luna" : "gemini-2.5-flash",
    explanationLanguage: "Russian",
    alwaysExplain: false,
    onUpdate,
  };
}

function proofreadOpts(provider: ProviderId) {
  return {
    provider,
    apiKey: "test-key",
    model: provider === "openai" ? "gpt-6-luna" : "gemini-2.5-flash",
    formal: false,
  };
}

async function main() {
  // --- translate reader ----------------------------------------------------------
  const full = `набор\n${EXPLANATION_MARK}\n## Значения\n1. (сущ.) набор\n2. (гл.) ставить`;

  await check("reader: every streamed prefix hides the mark", () => {
    let last = "";
    for (const raw of prefixes(full)) {
      const progress = readTranslateOutput(raw, false);
      assertNoMark(progress, raw);
      assert.ok(
        progress.translation.startsWith(
          last.slice(0, progress.translation.length),
        ),
      );
      last = progress.translation;
    }
  });

  await check("reader: final split into translation + block", () => {
    const result = readTranslateOutput(full, true);
    assert.equal(result.translation, "набор");
    assert.equal(
      result.explanation,
      "## Значения\n1. (сущ.) набор\n2. (гл.) ставить",
    );
    assert.equal(result.translationDone, true);
  });

  await check("reader: translation not final until the mark or the end", () => {
    assert.equal(readTranslateOutput("набор", false).translationDone, false);
    assert.equal(
      readTranslateOutput(`набор\n${EXPLANATION_MARK}`, false).translationDone,
      true,
    );
  });

  await check("reader: missing mark = whole text is the translation", () => {
    const result = readTranslateOutput("I will call you tomorrow", true);
    assert.deepEqual(result, {
      translation: "I will call you tomorrow",
      explanation: null,
      translationDone: true,
    });
  });

  await check(
    "reader: a text that merely ends in '<' is not cut at the end",
    () => {
      assert.equal(readTranslateOutput("a < b <", true).translation, "a < b <");
      assert.equal(readTranslateOutput("a < b <", false).translation, "a < b");
    },
  );

  for (const word of ["", "null", "NULL", "none", "N/A"]) {
    await check(
      `reader: no-block word ${JSON.stringify(word)} → explanation null`,
      () => {
        const raw = `перевод\n${EXPLANATION_MARK}\n${word}`;
        assert.equal(readTranslateOutput(raw, true).explanation, null);
        for (const partial of prefixes(raw)) {
          const progress = readTranslateOutput(partial, false);
          assertNoMark(progress, partial);
          assert.ok(
            !/^(n|nu|nul|null|no|non|none|n\/|n\/a)$/i.test(
              progress.explanation ?? "",
            ),
          );
        }
      },
    );
  }

  await check("reader: a block that starts like 'no…' still shows", () => {
    const raw = `перевод\n${EXPLANATION_MARK}\nNoun: a set`;
    assert.equal(readTranslateOutput(raw, true).explanation, "Noun: a set");
  });

  const fenced = `\`\`\`markdown\n${full}\n\`\`\``;
  await check("reader: a fence wrapping the whole output is stripped", () => {
    const result = readTranslateOutput(fenced, true);
    assert.equal(result.translation, "набор");
    assert.ok(!result.explanation?.includes("```"));
    for (const raw of prefixes(fenced)) {
      const progress = readTranslateOutput(raw, false);
      assertNoMark(progress, raw);
      assert.ok(
        !progress.translation.includes("`"),
        `fence leaked for ${JSON.stringify(raw)}`,
      );
    }
  });

  await check("reader: a code fence inside the block is kept", () => {
    const block = "Пример:\n```ts\nconst set = new Set();\n```";
    const raw = `набор\n${EXPLANATION_MARK}\n${block}`;
    assert.equal(readTranslateOutput(raw, true).explanation, block);
    assert.equal(
      readExplainOutput("## Block\n```ts\nx\n```", true),
      "## Block\n```ts\nx\n```",
    );
    // A model wrapper is stripped even when the block inside has code of its own.
    const wrapped = `\`\`\`\n${raw}\n\`\`\``;
    assert.deepEqual(readTranslateOutput(wrapped, true), {
      translation: "набор",
      explanation: block,
      translationDone: true,
    });
  });

  /** Once reported final, the translation never changes (and equals the end result). */
  function assertStableTranslation(full: string, input = "") {
    const final = readTranslateOutput(full, true, input).translation;
    for (const raw of prefixes(full)) {
      const progress = readTranslateOutput(raw, false, input);
      assertNoMark(progress, raw);
      if (progress.translationDone) {
        assert.equal(
          progress.translation,
          final,
          `changed after final at ${JSON.stringify(raw)}`,
        );
      }
    }
  }

  await check(
    "fence rule: model wrapper with a tagged code example (N1)",
    () => {
      const full =
        "```markdown\nнабор\n<<<EXPLANATION>>>\nПример:\n```ts\nconst x = 1;\n```\n```";
      assert.deepEqual(readTranslateOutput(full, true), {
        translation: "набор",
        explanation: "Пример:\n```ts\nconst x = 1;\n```",
        translationDone: true,
      });
      assertStableTranslation(full);
      for (const raw of prefixes(full)) {
        assert.ok(
          !readTranslateOutput(raw, false).translation.includes("`"),
          JSON.stringify(raw),
        );
      }
      assert.equal(
        readExplainOutput("```\n## B\n```ts\nx\n```\n```", true),
        "## B\n```ts\nx\n```",
      );
    },
  );

  await check(
    "fence rule: an input that is one fenced block keeps its fences",
    () => {
      const input = "```\n# get the user\nfoo()\n```";
      const full = "```\n# получить юзера\nfoo()\n```";
      assert.equal(readTranslateOutput(full, true, input).translation, full);
      for (const raw of prefixes(full)) {
        const shown = readTranslateOutput(raw, false, input).translation;
        assert.ok(full.startsWith(shown), JSON.stringify(shown));
      }
      assert.equal(
        readTranslateOutput(`${full}\n${EXPLANATION_MARK}\n## B`, true, input)
          .translation,
        full,
      );
      assertStableTranslation(`${full}\n${EXPLANATION_MARK}\n## B`, input);
      // Even a fence left open at the mark stays the author's for a fenced input.
      const open = `\`\`\`py\nx = 1\n${EXPLANATION_MARK}\n## B\n\`\`\``;
      assert.equal(
        readTranslateOutput(open, true, input).translation,
        "```py\nx = 1",
      );
      assert.equal(readTranslateOutput(open, true).translation, "x = 1");
      // Without a fenced input the same reply is a model wrapper.
      assert.equal(
        readTranslateOutput(full, true).translation,
        "# получить юзера\nfoo()",
      );
    },
  );

  await check(
    "fence rule: a fence tag like c++ streams and ends the same (N2)",
    () => {
      const full = "```c++\nint x;\n```";
      assert.equal(readTranslateOutput(full, true).translation, "int x;");
      for (const raw of prefixes(full)) {
        const shown = readTranslateOutput(raw, false).translation;
        assert.ok(
          !shown.includes("+") && !shown.includes("`"),
          JSON.stringify(shown),
        );
      }
    },
  );

  await check("fence rule: translations stay stable once final", () => {
    for (const sample of [
      full,
      "```\nnpm install\n```\nInstall it\n<<<EXPLANATION>>>\n```sh\nnpm i\n```",
      "```markdown\nset\n<<<EXPLANATION>>>\n## B\n```",
      "`npm i` — установка\n<<<EXPLANATION>>>\nnull",
    ]) {
      assertStableTranslation(sample);
    }
  });

  await check("defused mark copied back by the model is restored", () => {
    const result = readTranslateOutput(
      `Use ${DEFUSED_MARK} as a separator`,
      true,
    );
    assert.deepEqual(result, {
      translation: `Use ${EXPLANATION_MARK} as a separator`,
      explanation: null,
      translationDone: true,
    });
  });

  await check(
    "reader: a code block at the start of a translation survives",
    () => {
      const codeFirst = "```\nnpm install\n```\nInstall the dependencies";
      assert.equal(readTranslateOutput(codeFirst, true).translation, codeFirst);
      const withBlock = `${codeFirst}\n${EXPLANATION_MARK}\nПример:\n\`\`\`sh\nnpm i\n\`\`\``;
      const result = readTranslateOutput(withBlock, true);
      assert.equal(result.translation, codeFirst);
      assert.equal(result.explanation, "Пример:\n```sh\nnpm i\n```");
      // While streaming the leading fence is held back only until a second fence proves it is code.
      for (const raw of prefixes(withBlock)) {
        assertNoMark(readTranslateOutput(raw, false), raw);
      }
      assert.equal(
        readTranslateOutput(codeFirst, false).translation,
        codeFirst,
      );
    },
  );

  await check("reader: a repeated mark inside the block never shows", () => {
    const dup = `набор\n${EXPLANATION_MARK}\n## Значения\n1. set\n${EXPLANATION_MARK}`;
    assert.equal(
      readTranslateOutput(dup, true).explanation,
      "## Значения\n1. set",
    );
    for (const raw of prefixes(dup)) {
      assertNoMark(readTranslateOutput(raw, false), raw);
    }
    const partial = `набор\n${EXPLANATION_MARK}\n## Значения\n<<<EXPL`;
    assert.equal(
      readTranslateOutput(partial, false).explanation,
      "## Значения",
    );
    const echoed = `набор\n${EXPLANATION_MARK}\n## B\n${EXPLANATION_MARK}`;
    assert.equal(readExplainOutput(echoed, true), "## B");
  });

  await check("prompts: a mark in user text is neutralized", () => {
    const input = `Используй ${EXPLANATION_MARK} как разделитель`;
    assert.ok(!buildTranslateUserPrompt(input).includes(EXPLANATION_MARK));
    assert.ok(
      !buildTranslateUserPrompt(input, "translation").includes(
        EXPLANATION_MARK,
      ),
    );
    assert.ok(!buildExplainUserPrompt(input, input).includes(EXPLANATION_MARK));
  });

  await check("defang: no auto-loading image survives any backslashes", () => {
    assert.equal(defangImages("![x](u)"), "!\\[x](u)");
    assert.equal(defangImages("\\![x](u)"), "\\!\\[x](u)");
    assert.equal(defangImages("\\\\![x](u)"), "\\\\!\\[x](u)");
    for (const text of [
      "![x](u)",
      "\\![x](u)",
      "\\\\![x](u)",
      "a ![b][ref] c",
    ]) {
      assert.ok(!defangImages(text).includes("!["), text);
    }
  });

  await check(
    "reader: old-style JSON is parsed, and hidden while streaming",
    () => {
      const json = '{"translation": "set", "explanation": "## Block"}';
      assert.deepEqual(readTranslateOutput(json, true), {
        translation: "set",
        explanation: "## Block",
        translationDone: true,
      });
      assert.equal(
        readTranslateOutput(json.slice(0, 20), false).translation,
        "",
      );
      const fencedJson = `\`\`\`json\n${json}\n\`\`\``;
      assert.equal(readTranslateOutput(fencedJson, true).translation, "set");
    },
  );

  await check("reader: broken JSON falls back to the raw text", () => {
    const broken = '{"translation": "set", "expl';
    assert.equal(readTranslateOutput(broken, true).translation, broken);
  });

  await check(
    "explain reader: hides a partial mark, drops an echoed one",
    () => {
      const raw = `${EXPLANATION_MARK}\n## Block`;
      for (const partial of prefixes(raw)) {
        assert.ok(!readExplainOutput(partial, false).includes("<<<"));
      }
      assert.equal(readExplainOutput(raw, true), "## Block");
      assert.equal(readExplainOutput("## Block", true), "## Block");
    },
  );

  // --- SSE parser ------------------------------------------------------------------
  const sse =
    'event: response.created\ndata: {"a":1}\n\n: keep-alive\n\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
  const expected = ['{"a":1}', "line1\nline2"];

  for (const [name, text] of [
    ["LF", sse],
    ["CRLF", sse.replace(/\n/g, "\r\n")],
  ]) {
    await check(`sse: ${name}, split at every position`, () => {
      for (let i = 0; i <= text.length; i++) {
        const parser = new SseParser();
        const events = [
          ...parser.push(text.slice(0, i)),
          ...parser.push(text.slice(i)),
          ...parser.flush(),
        ];
        assert.deepEqual(events, expected, `split at ${i}`);
      }
    });
  }

  await check(
    "sse: last event without a trailing blank line is flushed",
    () => {
      const parser = new SseParser();
      assert.deepEqual(parser.push("data: tail"), []);
      assert.deepEqual(parser.flush(), ["tail"]);
    },
  );

  await check("sse: UTF-8 split inside a character decodes cleanly", () => {
    const bytes = new TextEncoder().encode("data: привет, мир\n\n");
    for (let i = 0; i <= bytes.length; i++) {
      const decoder = new TextDecoder("utf-8");
      const parser = new SseParser();
      const events = [
        ...parser.push(decoder.decode(bytes.slice(0, i), { stream: true })),
        ...parser.push(decoder.decode(bytes.slice(i), { stream: true })),
        ...parser.push(decoder.decode()),
        ...parser.flush(),
      ];
      assert.deepEqual(events, ["привет, мир"], `split at byte ${i}`);
    }
  });

  // --- provider folding --------------------------------------------------------------
  await check("openai fold: deltas, completed, incomplete reasons", () => {
    const seen: string[] = [];
    const push = (delta: string) => seen.push(delta);
    assert.deepEqual(
      foldOpenAIEvent(
        '{"type":"response.output_text.delta","delta":"Hi"}',
        push,
      ),
      {},
    );
    assert.deepEqual(seen, ["Hi"]);
    assert.equal(
      foldOpenAIEvent('{"type":"response.completed","response":{}}', push)
        .finish,
      "done",
    );
    const cut = foldOpenAIEvent(
      '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
      push,
    );
    assert.deepEqual(cut, { finish: "truncated", reason: "max_output_tokens" });
    const filtered = foldOpenAIEvent(
      '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}',
      push,
    );
    assert.equal(filtered.finish, "blocked");
  });

  await check("openai fold: refusal, failed and error events throw", () => {
    const noop = () => undefined;
    for (const data of [
      '{"type":"response.refusal.delta","delta":"no"}',
      '{"type":"response.failed","response":{"error":{"code":"server_error"}}}',
      '{"type":"error","code":"ERR"}',
    ]) {
      assert.throws(() => foldOpenAIEvent(data, noop), ProviderError);
    }
  });

  await check(
    "gemini fold: text, thought parts skipped, finish reason, block",
    () => {
      const seen: string[] = [];
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "secret", thought: true }, { text: "Hi" }],
            },
            finishReason: "MAX_TOKENS",
          },
        ],
      });
      assert.deepEqual(
        foldGeminiChunk(chunk, (d) => seen.push(d)),
        { reason: "MAX_TOKENS" },
      );
      assert.deepEqual(seen, ["Hi"]);
      const blocked = JSON.stringify({
        promptFeedback: { blockReason: "SAFETY" },
      });
      assert.throws(
        () => foldGeminiChunk(blocked, () => undefined),
        ProviderError,
      );
    },
  );

  // --- translate end to end over a stubbed stream ----------------------------------
  const pieces = ["на", "бор\n<<<EXP", "LANATION>>>\n## Зна", "чения"];

  await check(
    "translate (openai stream): updates hide the mark, result is whole",
    async () => {
      const events = [
        ...pieces.map((delta) =>
          JSON.stringify({ type: "response.output_text.delta", delta }),
        ),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ];
      useReply(sseReply(events));
      const updates: TranslateProgress[] = [];
      const result = await translate(
        "set",
        translateOpts("openai", (p) => updates.push(p)),
      );
      updates.forEach((p) => assertNoMark(p, JSON.stringify(p)));
      assert.deepEqual(result, {
        translation: "набор",
        explanation: "## Значения",
        cutShort: null,
      });
    },
  );

  await check(
    "translate (gemini stream): MAX_TOKENS is reported as cut short",
    async () => {
      const events = pieces.map((text, i) =>
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text }] },
              ...(i === pieces.length - 1
                ? { finishReason: "MAX_TOKENS" }
                : {}),
            },
          ],
        }),
      );
      useReply(sseReply(events));
      const result = await translate("set", translateOpts("gemini"));
      assert.equal(result.translation, "набор");
      assert.equal(result.cutShort, "MAX_TOKENS");
    },
  );

  await check(
    "translate (openai stream): no terminal event = cut short",
    async () => {
      useReply(
        sseReply([
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "набор",
          }),
        ]),
      );
      const result = await translate("set", translateOpts("openai"));
      assert.equal(result.cutShort, "stream ended early");
    },
  );

  // --- proofread completeness gate (proofread streams too) ----------------------------
  const geminiChunk = (text: string, finishReason?: string) =>
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text }] },
          ...(finishReason ? { finishReason } : {}),
        },
      ],
    });
  const openaiDelta = (delta: string) =>
    JSON.stringify({ type: "response.output_text.delta", delta });

  await check(
    "proofread (gemini): finishReason MAX_TOKENS is rejected",
    async () => {
      useReply(sseReply([geminiChunk("half", "MAX_TOKENS")]));
      await assert.rejects(
        proofread("text", proofreadOpts("gemini")),
        /stopped early \(MAX_TOKENS\)/,
      );
    },
  );

  await check(
    "proofread (gemini): a stream with no finishReason is rejected",
    async () => {
      useReply(sseReply([geminiChunk("half")]));
      await assert.rejects(
        proofread("text", proofreadOpts("gemini")),
        /stream ended early/,
      );
    },
  );

  await check("proofread (gemini): STOP passes", async () => {
    useReply(sseReply([geminiChunk("Fixed "), geminiChunk("text", "STOP")]));
    assert.deepEqual(await proofread("fix text", proofreadOpts("gemini")), {
      text: "Fixed text",
    });
  });

  await check("proofread: a fenced selection keeps its fences", async () => {
    const selection = "```\nconst a = 1\n```";
    useReply(sseReply([geminiChunk("```\nconst a = 1;\n```", "STOP")]));
    assert.deepEqual(await proofread(selection, proofreadOpts("gemini")), {
      text: "```\nconst a = 1;\n```",
    });
    // A plain selection the model wrapped in a fence is unwrapped.
    useReply(sseReply([geminiChunk("```text\nFixed text\n```", "STOP")]));
    assert.deepEqual(await proofread("fix text", proofreadOpts("gemini")), {
      text: "Fixed text",
    });
  });

  await check(
    "proofread (openai): response.incomplete is rejected",
    async () => {
      useReply(
        sseReply([
          openaiDelta("half"),
          JSON.stringify({
            type: "response.incomplete",
            response: { incomplete_details: { reason: "max_output_tokens" } },
          }),
        ]),
      );
      await assert.rejects(
        proofread("text", proofreadOpts("openai")),
        /OpenAI stopped early \(max_output_tokens\)/,
      );
    },
  );

  await check("proofread (openai): no terminal event is rejected", async () => {
    useReply(sseReply([openaiDelta("half")]));
    await assert.rejects(
      proofread("text", proofreadOpts("openai")),
      /stream ended early/,
    );
  });

  await check("proofread (openai): refusal is rejected", async () => {
    useReply(
      sseReply([
        JSON.stringify({ type: "response.refusal.delta", delta: "no" }),
      ]),
    );
    await assert.rejects(proofread("text", proofreadOpts("openai")), /refused/);
  });

  await check("proofread (openai): completed result passes", async () => {
    useReply(
      sseReply([
        openaiDelta("Fixed "),
        openaiDelta("text"),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    );
    assert.deepEqual(await proofread("fix text", proofreadOpts("openai")), {
      text: "Fixed text",
    });
  });

  await check(
    "translate (translation part): a cut-short translation reports it",
    async () => {
      useReply(
        sseReply([
          openaiDelta("The first half"),
          JSON.stringify({
            type: "response.incomplete",
            response: { incomplete_details: { reason: "content_filter" } },
          }),
        ]),
      );
      const cut = await translate(
        "текст",
        translateOpts("openai"),
        "translation",
      );
      assert.deepEqual(cut, {
        translation: "The first half",
        explanation: null,
        cutShort: "content_filter",
      });
      useReply(sseReply([geminiChunk("Половина")]));
      const open = await translate(
        "half",
        translateOpts("gemini"),
        "translation",
      );
      assert.equal(open.cutShort, "stream ended early");
    },
  );

  await check("gemini: thinking config and headroom per model", () => {
    const table: Array<[string, Record<string, unknown> | undefined]> = [
      ["gemini-2.5-flash", { thinkingBudget: 0 }],
      ["gemini-2.5-flash-lite", { thinkingBudget: 0 }],
      ["gemini-2.5-pro", { thinkingBudget: 128 }],
      ["gemini-2.0-flash", undefined],
      ["gemini-3-flash-preview", { thinkingLevel: "minimal" }],
      ["Gemini-3.5-Flash", { thinkingLevel: "minimal" }],
      ["gemini-3.6-flash", { thinkingLevel: "minimal" }],
      ["gemini-3.1-flash-lite", { thinkingLevel: "minimal" }],
      ["gemini-3.5-flash-lite", { thinkingLevel: "minimal" }],
      ["gemini-3.1-flash-lite-image", { thinkingLevel: "minimal" }],
      ["gemini-3.7-flash-lite", { thinkingLevel: "low" }],
      ["gemini-3.7-flash", { thinkingLevel: "low" }],
      ["gemini-3.8-flash", { thinkingLevel: "low" }],
      ["gemini-3.1-pro-preview", { thinkingLevel: "low" }],
      ["gemini-flash-latest", undefined],
    ];
    for (const [model, expected] of table) {
      assert.deepEqual(thinkingFor(model), expected, model);
      const body = buildBody({
        system: "s",
        user: "u",
        maxTokens: 512,
        opts: { provider: "gemini", apiKey: "k", model },
      }) as { generationConfig: { maxOutputTokens: number } };
      const off = expected?.thinkingBudget === 0;
      assert.equal(
        body.generationConfig.maxOutputTokens,
        512 + (off ? 0 : THINKING_HEADROOM),
        model,
      );
    }
  });

  await check(
    "openai: a 400 on reasoning.effort gets the model hint",
    async () => {
      useReply(
        () =>
          new Response(
            JSON.stringify({
              error: { param: "reasoning.effort", message: "x" },
            }),
            { status: 400 },
          ),
      );
      await assert.rejects(
        proofread("text", proofreadOpts("openai")),
        /does not accept reasoning effort "none"/,
      );
    },
  );

  await check("auth errors name the provider", async () => {
    await assert.rejects(
      translate("text", { ...translateOpts("openai"), apiKey: "" }),
      /No OpenAI API key set\..*switch Provider to Gemini/,
    );
    await assert.rejects(
      proofread("text", { ...proofreadOpts("gemini"), apiKey: "" }),
      /No Gemini API key set/,
    );
  });

  // --- idle timeout and cancellation ---------------------------------------------------
  /** A body that never sends a byte; it errors only when the request aborts. */
  function silentReply(signal: { current?: AbortSignal }): Reply {
    return () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.current?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
        { status: 200 },
      );
  }

  function stubSilent() {
    const holder: { current?: AbortSignal } = {};
    const reply = silentReply(holder);
    globalThis.fetch = (async (
      _url: unknown,
      init?: { signal?: AbortSignal },
    ) => {
      holder.current = init?.signal ?? undefined;
      return reply();
    }) as typeof fetch;
  }

  await check(
    "postStream: silence between chunks past idleMs is a timeout",
    async () => {
      globalThis.fetch = (async (
        _url: unknown,
        init?: { signal?: AbortSignal },
      ) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;
      await assert.rejects(
        postStream({
          url: "http://stub",
          headers: {},
          body: {},
          label: "Stub",
          onEvent: () => undefined,
          idleMs: 50,
          firstByteMs: 5_000,
        }),
        (error: unknown) =>
          error instanceof ProviderError && error.kind === "timeout",
      );
    },
  );

  await check(
    "postStream: external abort is rethrown as-is (caller ignores it)",
    async () => {
      stubSilent();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(
        postStream({
          url: "http://stub",
          headers: {},
          body: {},
          label: "Stub",
          signal: controller.signal,
          onEvent: () => undefined,
          idleMs: 5_000,
        }),
        (error: unknown) => !(error instanceof ProviderError),
      );
    },
  );

  await check(
    "postStream: first-byte window applies until the first chunk",
    async () => {
      stubSilent();
      await assert.rejects(
        postStream({
          url: "http://stub",
          headers: {},
          body: {},
          label: "Stub",
          onEvent: () => undefined,
          idleMs: 5_000,
          firstByteMs: 50,
        }),
        (error: unknown) =>
          error instanceof ProviderError && error.kind === "timeout",
      );
    },
  );

  await check(
    "postStream: the window is re-armed when the headers arrive",
    async () => {
      // Headers after 150 ms, first chunk 120 ms later: 270 ms total is past the
      // 200 ms first-byte window, so this passes only if the headers re-arm it.
      const events: string[] = [];
      globalThis.fetch = (async (
        _url: unknown,
        init?: { signal?: AbortSignal },
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Like a real fetch body: an abort errors the pending read.
            init?.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
            setTimeout(() => {
              if (init?.signal?.aborted) {
                return;
              }
              controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
              controller.close();
            }, 120);
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;
      await postStream({
        url: "http://stub",
        headers: {},
        body: {},
        label: "Stub",
        onEvent: (data) => events.push(data),
        idleMs: 5_000,
        firstByteMs: 200,
      });
      assert.deepEqual(events, ["hi"]);
    },
  );

  await check(
    "postStream: a drop mid-response says the connection was lost",
    async () => {
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: part\n\n"));
            setTimeout(() => controller.error(new TypeError("terminated")), 20);
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;
      const events: string[] = [];
      await assert.rejects(
        postStream({
          url: "http://stub",
          headers: {},
          body: {},
          label: "Stub",
          onEvent: (data) => events.push(data),
        }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.kind === "network" &&
          /lost mid-response/.test(error.message),
      );
      assert.deepEqual(events, ["part"]);
    },
  );

  globalThis.fetch = realFetch;
  console.log(`\n${passed} checks passed.`);
}

void main();
