import assert from "node:assert/strict";
import test from "node:test";
import { resolveLlmProvider } from "../api/llmApi";

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
