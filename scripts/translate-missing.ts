#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Syncs the overlay's ru_RU/translation.json against the upstream en_US one.
 *
 * Reads ../.build/outline/shared/i18n/locales/en_US/translation.json (put there
 * by build.sh --skip-build) and ../overlay/shared/i18n/locales/ru_RU/translation.json.
 *
 *  - keys present in en_US but missing in ru_RU → translated via a provider
 *    (Anthropic or OpenAI, see resolveProvider below)
 *  - keys present in ru_RU but absent in en_US → removed
 *  - existing translations are kept untouched
 *  - the final file is written with keys in en_US order, preserving stable git diffs
 *  - the list of machine-translated keys is appended to .auto-translated.json,
 *    so a human reviewer can find them in a follow-up pass
 *
 * i18next interpolation placeholders ({{ foo }}, {{foo}}) and simple HTML-like
 * tags (<0>, </0>, <strong>...</strong>) are preserved verbatim — the prompt
 * instructs the model not to translate or reorder them, and we validate after.
 *
 * Provider selection (in order of precedence):
 *   1. TRANSLATION_PROVIDER=anthropic|openai — explicit choice
 *   2. OPENAI_API_KEY set → openai
 *   3. ANTHROPIC_API_KEY set → anthropic
 *   4. none → keys are kept as English fallback and logged for manual work
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERLAY_ROOT = resolve(__dirname, "..");
const UPSTREAM_EN = resolve(
  OVERLAY_ROOT,
  ".build/outline/shared/i18n/locales/en_US/translation.json"
);
const OVERLAY_RU = resolve(
  OVERLAY_ROOT,
  "overlay/shared/i18n/locales/ru_RU/translation.json"
);
const AUTO_LOG = resolve(
  OVERLAY_ROOT,
  "overlay/shared/i18n/locales/ru_RU/.auto-translated.json"
);

const BATCH_SIZE = Number(process.env.TRANSLATE_BATCH_SIZE ?? 40);

type Dict = Record<string, string>;

type ProviderName = "anthropic" | "openai";

interface TranslateBatch {
  (keys: string[]): Promise<TranslateResult>;
}

interface TranslateResult {
  translations: Record<string, string>;
  failures: string[];
}

const SYSTEM_PROMPT = [
  "You translate UI strings from English (en_US) into Russian (ru_RU) for a collaborative knowledge-base app called Outline.",
  "Rules:",
  "1. Preserve ALL i18next placeholders like {{ variable }} verbatim, including spaces inside braces.",
  "2. Preserve ALL HTML-like tags such as <0>, </0>, <strong>, </strong> verbatim and in the same order.",
  "3. Use natural, professional Russian phrasing as seen in modern SaaS products (avoid machine-translation literalism).",
  "4. Use informal 'вы' (lowercase) when addressing the user.",
  "5. Keep well-known product/UI terms untranslated when idiomatic in Russian tech speak (e.g. 'API', 'webhook', 'JSON', 'OAuth', 'Slack', 'Google').",
  "6. Do NOT add quotes, trailing punctuation or explanations — return only the translated string.",
  "7. Output MUST be a single JSON object mapping each input key verbatim to its translation. No prose, no markdown fences.",
].join("\n");

function loadJson(path: string): Dict {
  if (!existsSync(path)) {
    throw new Error(`missing file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Dict;
}

function saveJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Extracts placeholders and tags from a source string so we can verify the
 * model preserved them. Any divergence → we keep the English source instead
 * and mark the key for manual review.
 */
function placeholders(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\{\{\s*[^}]+?\s*\}\}/g)) {
    out.push(m[0].replace(/\s+/g, ""));
  }
  for (const m of s.matchAll(/<\/?\w+[^>]*>/g)) {
    out.push(m[0]);
  }
  return out.sort();
}

function sameShape(a: string, b: string): boolean {
  const pa = placeholders(a);
  const pb = placeholders(b);
  if (pa.length !== pb.length) {
    return false;
  }
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] !== pb[i]) {
      return false;
    }
  }
  return true;
}

function buildUserPrompt(keys: string[]): string {
  return [
    "Translate each of the following keys into Russian, following all rules.",
    "Input JSON:",
    JSON.stringify(Object.fromEntries(keys.map((k) => [k, k])), null, 2),
    "Return a single JSON object with the same keys and Russian translations as values.",
  ].join("\n\n");
}

function validateBatchResponse(
  keys: string[],
  parsed: Dict | null
): TranslateResult {
  if (!parsed) {
    return { translations: {}, failures: keys };
  }
  const translations: Record<string, string> = {};
  const failures: string[] = [];
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value !== "string" || value.length === 0) {
      failures.push(key);
      continue;
    }
    if (!sameShape(key, value)) {
      failures.push(key);
      continue;
    }
    translations[key] = value;
  }
  return { translations, failures };
}

function parseJsonObject(text: string): Dict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as Dict;
  } catch {
    return null;
  }
}

function makeAnthropicBatch(apiKey: string): TranslateBatch {
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  return async (keys) => {
    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildUserPrompt(keys) }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return validateBatchResponse(keys, parseJsonObject(text));
  };
}

function makeOpenAiBatch(apiKey: string): TranslateBatch {
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return async (keys) => {
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(keys) },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? "";
    return validateBatchResponse(keys, parseJsonObject(text));
  };
}

function resolveProvider(): {
  name: ProviderName;
  batch: TranslateBatch;
} | null {
  const explicit = process.env.TRANSLATION_PROVIDER?.toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (explicit === "openai") {
    if (!openaiKey) {
      console.error("TRANSLATION_PROVIDER=openai but OPENAI_API_KEY is not set");
      return null;
    }
    return { name: "openai", batch: makeOpenAiBatch(openaiKey) };
  }
  if (explicit === "anthropic") {
    if (!anthropicKey) {
      console.error(
        "TRANSLATION_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set"
      );
      return null;
    }
    return { name: "anthropic", batch: makeAnthropicBatch(anthropicKey) };
  }
  if (explicit && explicit.length > 0) {
    console.error(
      `unknown TRANSLATION_PROVIDER=${explicit} (expected 'anthropic' or 'openai')`
    );
    return null;
  }

  if (openaiKey) {
    return { name: "openai", batch: makeOpenAiBatch(openaiKey) };
  }
  if (anthropicKey) {
    return { name: "anthropic", batch: makeAnthropicBatch(anthropicKey) };
  }
  return null;
}

async function main(): Promise<void> {
  const en = loadJson(UPSTREAM_EN);
  const ru = loadJson(OVERLAY_RU);
  const autoLog: { translatedAt: string; keys: string[] } = existsSync(AUTO_LOG)
    ? JSON.parse(readFileSync(AUTO_LOG, "utf8"))
    : { translatedAt: "", keys: [] };

  const missing = Object.keys(en).filter((k) => !(k in ru));
  const removed = Object.keys(ru).filter((k) => !(k in en));

  console.log(`en_US keys: ${Object.keys(en).length}`);
  console.log(`ru_RU keys: ${Object.keys(ru).length}`);
  console.log(`missing in ru_RU: ${missing.length}`);
  console.log(`stale in ru_RU (will be removed): ${removed.length}`);

  if (removed.length > 0) {
    for (const k of removed) {
      delete ru[k];
    }
  }

  const newlyTranslated: string[] = [];
  const unresolved: string[] = [];

  if (missing.length > 0) {
    const provider = resolveProvider();
    if (!provider) {
      console.error(
        "No translation provider configured — set OPENAI_API_KEY or ANTHROPIC_API_KEY (optionally TRANSLATION_PROVIDER to pick one). Missing keys will fall back to English."
      );
      for (const k of missing) {
        ru[k] = k;
        unresolved.push(k);
      }
    } else {
      console.log(`> using provider: ${provider.name}`);
      const total = Math.ceil(missing.length / BATCH_SIZE);
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        console.log(
          `> batch ${i / BATCH_SIZE + 1}/${total} (${batch.length} keys)`
        );
        const { translations, failures } = await provider.batch(batch);
        for (const [k, v] of Object.entries(translations)) {
          ru[k] = v;
          newlyTranslated.push(k);
        }
        for (const k of failures) {
          ru[k] = k;
          unresolved.push(k);
        }
      }
    }
  }

  const ordered: Dict = {};
  for (const k of Object.keys(en)) {
    ordered[k] = ru[k] ?? k;
  }
  saveJson(OVERLAY_RU, ordered);

  if (newlyTranslated.length > 0 || unresolved.length > 0) {
    const merged = new Set([...autoLog.keys, ...newlyTranslated, ...unresolved]);
    saveJson(AUTO_LOG, {
      translatedAt: new Date().toISOString(),
      keys: [...merged].sort(),
    });
  }

  console.log(`translated: ${newlyTranslated.length}`);
  console.log(`unresolved (English fallback, needs review): ${unresolved.length}`);
  console.log(`removed stale: ${removed.length}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
