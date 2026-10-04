import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

export type LlmProvider = "lmstudio" | "gemini" | "groq";


// Model chains: the top entry is tried first, then each next entry on API or
// other failures. Override per provider with a comma-separated env list, e.g.
// GROQ_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b".
// The older single-model vars (LM_STUDIO_MODEL, GEMINI_MODEL, GROQ_MODEL,
// GROQ_FALLBACK_MODEL) are still honored when the matching *_MODELS list is
// unset: GROQ_MODEL/GROQ_FALLBACK_MODEL become the two-entry chain, the
// others become a one-entry chain.
const DEFAULT_LM_STUDIO_MODELS = ["gemma-4-e4b"];
const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash"];
// gpt-oss-20b is weak at numeric gram-weight conversion and candidate
// discrimination. gpt-oss-120b is the same family/instruction format on the
// same free tier (30 RPM / 1K RPD), but far stronger at both, with JSON
// object/schema mode. (llama-3.1/3.3 were retired on free/dev tiers in Aug
// 2026; qwen3.x are Preview-only, pricier, and lack JSON schema mode.)
const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

function splitModelList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
}

/**
 * Ordered models for a provider, read live from the environment so tests and
 * config changes apply without a restart of the module graph.
 */
export function resolveModelChain(provider: LlmProvider = resolveLlmProvider()): string[] {
  switch (provider) {
    case "groq": {
      const fromList = splitModelList(process.env.GROQ_MODELS);
      if (fromList.length > 0) return [...new Set(fromList)];
      return [...new Set([
        process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODELS[0],
        process.env.GROQ_FALLBACK_MODEL?.trim() || DEFAULT_GROQ_MODELS[1],
      ])];
    }
    case "gemini": {
      const fromList = splitModelList(process.env.GEMINI_MODELS);
      if (fromList.length > 0) return [...new Set(fromList)];
      return [process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODELS[0]];
    }
    case "lmstudio": {
      const fromList = splitModelList(process.env.LM_STUDIO_MODELS);
      if (fromList.length > 0) return [...new Set(fromList)];
      return [process.env.LM_STUDIO_MODEL?.trim() || DEFAULT_LM_STUDIO_MODELS[0]];
    }
  }
}

const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1";
const GROQ_BASE_URL = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");

const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? 8192);

const MIN_GENERATION_INTERVAL_MS = 1000;
const lastGenerationAt = { time: 0 };

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : undefined;

export function resolveGroqModels(): { primary: string; fallback: string } {
  const [primary, fallback] = resolveModelChain("groq");
  return { primary, fallback: fallback ?? primary };
}

export interface LlmModelUse {
  provider: LlmProvider;
  model: string;
}

let lastLlmModelUse: LlmModelUse | null = null;

/** The provider/model that served the most recent LLM call, if any yet. */
export function getLastLlmModel(): LlmModelUse | null {
  return lastLlmModelUse ? { ...lastLlmModelUse } : null;
}

/**
 * Short label of the active chain for logs and progress messages, e.g.
 * "groq: openai/gpt-oss-120b → openai/gpt-oss-20b".
 */
export function llmChainLabel(provider: LlmProvider = resolveLlmProvider()): string {
  return `${provider}: ${resolveModelChain(provider).join(" → ")}`;
}

/**
 * Chain-stopping errors: missing keys and auth rejections fail the same way
 * on every model in the chain, so they surface immediately instead of burning
 * through the list. Everything else (rate limits, server errors, retired or
 * unknown model IDs, network failures, malformed JSON) moves down the chain.
 */
function isChainStoppingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /API_KEY must be set|request failed: (401|403)\b/i.test(message);
}

/**
 * Resolves the configured provider. LLM_PROVIDER defaults to LM Studio to
 * preserve the previous local-first behavior.
 */
export function resolveLlmProvider(value = process.env.LLM_PROVIDER): LlmProvider {
  const provider = value?.trim().toLowerCase() || "lmstudio";
  switch (provider) {
    case "lmstudio":
    case "lm-studio":
    case "lm_studio":
    case "local":
      return "lmstudio";
    case "gemini":
      return "gemini";
    case "groq":
      return "groq";
    default:
      throw new Error("LLM_PROVIDER must be one of: lmstudio, gemini, groq.");
  }
}

/**
 * Runs one prompt against a single model in the chain. Records and logs the
 * model so the console (and, via getLastLlmModel, the food-log progress
 * messages) always shows which list entry actually served the call.
 */
async function generateWithModel(
  provider: LlmProvider,
  model: string,
  prompt: string,
  jsonMode: boolean,
): Promise<string> {
  const elapsed = Date.now() - lastGenerationAt.time;
  if (elapsed < MIN_GENERATION_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_GENERATION_INTERVAL_MS - elapsed));
  }
  lastGenerationAt.time = Date.now();

  let text: string;
  switch (provider) {
    case "lmstudio":
      text = await generateLocalLmStudioContent(prompt, model, jsonMode);
      break;
    case "gemini":
      text = await generateGeminiContent(prompt, model);
      break;
    case "groq":
      text = await generateGroqContent(prompt, model, jsonMode);
      break;
  }

  lastLlmModelUse = { provider, model };
  console.log(`[LLM] using ${provider}/${model}`);
  return text;
}

export async function generate(prompt: string, jsonMode = false): Promise<string> {
  const provider = resolveLlmProvider();
  const chain = resolveModelChain(provider);
  let lastError: unknown;

  for (const model of chain) {
    try {
      return await generateWithModel(provider, model, prompt, jsonMode);
    } catch (error) {
      lastError = error;
      if (isChainStoppingError(error)) throw error;
      if (model !== chain[chain.length - 1]) {
        console.warn(`[LLM] ${provider}/${model} failed (${shortError(error)}). Trying next model in the chain...`);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, 160);
}

/**
 * Pulls the JSON payload out of a model response. Reasoning models (notably
 * Groq's gpt-oss) often wrap the answer in <think> blocks, code fences, or
 * trailing commentary even in JSON mode, so the raw text is rarely bare JSON.
 */
export function extractJsonPayload(raw: string): string {
  let text = raw.trim();
  // Drop chain-of-thought blocks emitted by reasoning models.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Prefer an explicit fenced block when the model used one.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) text = fenced[1].trim();
  else {
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  if (!text) return text;

  // Fast path: the whole response is already JSON.
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Fall through to substring extraction below.
  }

  // Find the largest JSON array/object substring (first opener to last closer).
  const firstArray = text.indexOf("[");
  const firstObject = text.indexOf("{");
  let start = -1;
  let endChar = "";
  if (firstArray !== -1 && (firstObject === -1 || firstArray < firstObject)) {
    start = firstArray;
    endChar = "]";
  } else if (firstObject !== -1) {
    start = firstObject;
    endChar = "}";
  }
  if (start === -1) return text;
  const end = text.lastIndexOf(endChar);
  if (end <= start) return text;
  return text.slice(start, end + 1).trim();
}

/**
 * Shared JSON-generation loop: the attempt budget is spread across the active
 * model chain, so a model that keeps returning malformed JSON (or failing
 * requests) gives way to the next list entry instead of burning all attempts
 * on it. A single-model chain keeps the previous behavior of all attempts on
 * that model.
 */
async function generateParsedJson<T>(
  prompt: string,
  parse: (raw: string) => T,
  kind: string,
  attempts: number,
): Promise<T> {
  const provider = resolveLlmProvider();
  const chain = resolveModelChain(provider);
  const perModel = Math.max(1, Math.ceil(attempts / chain.length));
  let lastError: unknown;
  let lastRaw = "";

  for (const model of chain) {
    for (let attempt = 1; attempt <= perModel; attempt++) {
      try {
        const raw = await generateWithModel(provider, model, prompt, true);
        lastRaw = raw;
        return parse(raw);
      } catch (error) {
        lastError = error;
        console.warn(`[LLM] ${kind} via ${provider}/${model} failed on attempt ${attempt}/${perModel}:`, lastError instanceof Error ? lastError.message : String(lastError));
        if (isChainStoppingError(error)) throw error;
      }
    }
    if (model !== chain[chain.length - 1]) {
      console.warn(`[LLM] ${provider}/${model} exhausted its attempts. Moving to next model in the chain...`);
    }
  }

  throw new Error(
    `AI failed to return valid ${kind} after ${attempts} attempts across ${chain.length} model(s) [${chain.join(", ")}]. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}. Last response: ${lastRaw.slice(0, 500)}`,
  );
}

export async function generateJson(
  prompt: string,
  attempts = 6,
): Promise<JSON> {
  return generateParsedJson(prompt, raw => JSON.parse(extractJsonPayload(raw)) as JSON, "JSON", attempts);
}

/**
 * Reads a JSON array out of any model response shape. Bare arrays pass
 * through, while the object wrappers that JSON-object mode forces (for
 * example {"entries": [...]}) are unwrapped. A single entry object (for
 * example {"food_index": 0, ...} when only one food was logged) is wrapped
 * into a one-element array when it carries one of `singleEntryKeys`.
 */
export function coerceJsonArray(value: unknown, singleEntryKeys: string[] = []): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  for (const key of ["entries", "matches", "results", "items", "foods", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  const nestedArrays = Object.values(record).filter(Array.isArray);
  if (nestedArrays.length === 1) return nestedArrays[0] as unknown[];
  if (singleEntryKeys.some(key => key in record)) return [value];

  return undefined;
}

/**
 * Generates a JSON array, tolerating the object wrappers that forced JSON
 * mode produces. `response_format: {type: "json_object"}` requires the model
 * to return an object, so prompts using this helper must ask for
 * {"entries": [...]}-style output — a bare [...] response then fails
 * coercion-free parsing on providers that enforce object mode, surfacing as
 * "response was not a list". Non-array payloads (including wrong-wrapper
 * objects) consume an attempt and are retried like any other malformed JSON.
 */
export async function generateJsonArray(
  prompt: string,
  singleEntryKeys: string[] = [],
  attempts = 6,
): Promise<unknown[]> {
  return generateParsedJson(prompt, raw => {
    const parsed: unknown = JSON.parse(extractJsonPayload(raw));
    const array = coerceJsonArray(parsed, singleEntryKeys);
    if (array) return array;
    throw new Error(
      `expected a JSON array but got ${Array.isArray(parsed) ? "an array" : typeof parsed}: ${JSON.stringify(parsed)?.slice(0, 200)}`,
    );
  }, "JSON array", attempts);
}

async function generateGeminiContent(prompt: string, model: string): Promise<string> {
  if (!ai) {
    throw new Error("GEMINI_API_KEY must be set when LLM_PROVIDER=gemini.");
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
    },
  });

  return logGeneratedText("Gemini", model, response.text ?? "");
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

async function generateGroqContent(prompt: string, model: string, jsonMode = false): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GROQ_API_KEY must be set when LLM_PROVIDER=groq.");
  }

  // Failover across the chain lives in generate()/generateParsedJson, which
  // also own the per-model logging — this only performs the single request.
  return generateOpenAiCompatibleContent({
    provider: "Groq",
    baseUrl: GROQ_BASE_URL,
    model,
    prompt,
    authorization: `Bearer ${apiKey}`,
    // Forced JSON mode: without this Groq's chat models freely emit
    // reasoning text that fails JSON.parse 6 times in a row.
    jsonMode,
  });
}

async function generateLocalLmStudioContent(prompt: string, model: string, jsonMode = false): Promise<string> {
  return generateOpenAiCompatibleContent({
    provider: "LM Studio",
    baseUrl: LM_STUDIO_BASE_URL.replace(/\/+$/, ""),
    model,
    // /no_think is a local LM Studio prompt directive; it is intentionally
    // never sent to hosted providers.
    prompt: `${prompt.trim()}\n/no_think`,
    jsonMode,
  });
}

async function generateOpenAiCompatibleContent(options: {
  provider: string;
  baseUrl: string;
  model: string;
  prompt: string;
  authorization?: string;
  jsonMode?: boolean;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: options.prompt }],
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: false,
      // OpenAI-compatible forced JSON output. Groq honors this; LM Studio
      // versions that do not support it ignore unknown fields.
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${options.provider} request failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return logGeneratedText(options.provider, options.model, data.choices?.[0]?.message?.content ?? "");
}

function logGeneratedText(provider: string, model: string, text: string): string {
  if (process.env.DEBUG_AI_LOGGING === "true") {
    console.log(`\n${provider} (${model}):\n"${text}"\n`);
  }
  return text;
}
