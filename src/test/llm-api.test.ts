import assert from "node:assert/strict";
import test from "node:test";
import {
  coerceJsonArray,
  extractJsonPayload,
  getLastLlmModel,
  llmChainLabel,
  resolveGroqModels,
  resolveLlmProvider,
  resolveModelChain,
} from "../api/llmApi";

test("resolves the supported LLM providers and LM Studio aliases", () => {
  assert.equal(resolveLlmProvider(""), "lmstudio");
  assert.equal(resolveLlmProvider("lmstudio"), "lmstudio");
  assert.equal(resolveLlmProvider("lm-studio"), "lmstudio");
  assert.equal(resolveLlmProvider("local"), "lmstudio");
  assert.equal(resolveLlmProvider("gemini"), "gemini");
  assert.equal(resolveLlmProvider("groq"), "groq");
});

test("rejects an unsupported LLM provider before making a request", () => {
  assert.throws(() => resolveLlmProvider("unknown"), /LLM_PROVIDER/);
});

test("extracts JSON from reasoning wrappers, fences, and trailing text", () => {
  assert.deepEqual(JSON.parse(extractJsonPayload(`[{"food_index": 0}]`)), [{ food_index: 0 }]);
  assert.deepEqual(
    JSON.parse(extractJsonPayload(`<think>reasoning</think>\n[{"food_index": 0}]`)),
    [{ food_index: 0 }],
  );
  assert.deepEqual(
    JSON.parse(extractJsonPayload("```json\n{\"calories\": 30}\n```")),
    { calories: 30 },
  );
  assert.deepEqual(
    JSON.parse(extractJsonPayload(`Sure! Here you go: {"calories": 20} hope this helps`)),
    { calories: 20 },
  );
});

test("coerceJsonArray passes bare arrays through untouched", () => {
  const array = [{ food_index: 0 }];
  assert.equal(coerceJsonArray(array), array);
});

test("coerceJsonArray unwraps the object form forced JSON mode produces", () => {
  // response_format json_object forbids top-level arrays, so the parser and
  // matcher prompts request {"entries": [...] / {"matches": [...] wrappers.
  assert.deepEqual(
    coerceJsonArray({ entries: [{ new_food_queries: ["chicken"] }] }),
    [{ new_food_queries: ["chicken"] }],
  );
  assert.deepEqual(
    coerceJsonArray({ matches: [{ food_index: 0, candidate_match_index: null }] }),
    [{ food_index: 0, candidate_match_index: null }],
  );
  // Unknown single-wrapper keys still unwrap when unambiguous.
  assert.deepEqual(coerceJsonArray({ data: [1, 2] }), [1, 2]);
});

test("coerceJsonArray wraps a lone entry object instead of failing the log", () => {
  const entry = { food_index: 0, candidate_match_index: 2 };
  assert.deepEqual(coerceJsonArray(entry, ["food_index"]), [entry]);
  // Without entry-marker keys an object is not an array: retry, don't invent.
  assert.equal(coerceJsonArray({ calories: 30 }, ["food_index"]), undefined);
  assert.equal(coerceJsonArray("nope"), undefined);
  assert.equal(coerceJsonArray(null), undefined);
});

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("model chains default per provider with the strongest groq entry first", () => {
  withEnv({ GROQ_MODELS: undefined, GROQ_MODEL: undefined, GROQ_FALLBACK_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelChain("groq"), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });
  withEnv({ GEMINI_MODELS: undefined, GEMINI_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelChain("gemini"), ["gemini-2.5-flash"]);
  });
  withEnv({ LM_STUDIO_MODELS: undefined, LM_STUDIO_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelChain("lmstudio"), ["gemma-4-e4b"]);
  });
});

test("model chains parse comma lists with whitespace and dedup", () => {
  withEnv({ GROQ_MODELS: " openai/gpt-oss-120b , openai/gpt-oss-20b,openai/gpt-oss-120b " }, () => {
    assert.deepEqual(resolveModelChain("groq"), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });
  withEnv({ GEMINI_MODELS: "gemini-2.5-flash, gemini-2.0-flash" }, () => {
    assert.deepEqual(resolveModelChain("gemini"), ["gemini-2.5-flash", "gemini-2.0-flash"]);
  });
});

test("legacy single-model vars still work when the list var is unset", () => {
  withEnv({ GROQ_MODELS: undefined, GROQ_MODEL: "openai/gpt-oss-20b", GROQ_FALLBACK_MODEL: undefined }, () => {
    assert.deepEqual(resolveModelChain("groq"), ["openai/gpt-oss-20b"]);
  });
  withEnv({ GROQ_MODELS: undefined, GROQ_MODEL: "model-a", GROQ_FALLBACK_MODEL: "model-b" }, () => {
    assert.deepEqual(resolveModelChain("groq"), ["model-a", "model-b"]);
  });
  withEnv({ LM_STUDIO_MODELS: undefined, LM_STUDIO_MODEL: "granite-4.1-8b" }, () => {
    assert.deepEqual(resolveModelChain("lmstudio"), ["granite-4.1-8b"]);
  });
});

test("a set list var wins over legacy single-model vars", () => {
  withEnv({ GROQ_MODELS: "openai/gpt-oss-120b", GROQ_MODEL: "other-model", GROQ_FALLBACK_MODEL: "another" }, () => {
    assert.deepEqual(resolveModelChain("groq"), ["openai/gpt-oss-120b"]);
  });
});

test("groq compat shim exposes the chain head and next entry", () => {
  withEnv({ GROQ_MODELS: undefined, GROQ_MODEL: undefined, GROQ_FALLBACK_MODEL: undefined }, () => {
    assert.deepEqual(resolveGroqModels(), { primary: "openai/gpt-oss-120b", fallback: "openai/gpt-oss-20b" });
  });
});

test("chain label names the provider and every list entry in order", () => {
  withEnv({ GROQ_MODELS: "openai/gpt-oss-120b,openai/gpt-oss-20b" }, () => {
    assert.equal(llmChainLabel("groq"), "groq: openai/gpt-oss-120b → openai/gpt-oss-20b");
  });
});

test("no model has served a call before the first generation", () => {
  assert.equal(getLastLlmModel(), null);
});
