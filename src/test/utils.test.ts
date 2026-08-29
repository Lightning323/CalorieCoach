import assert from "node:assert/strict";
import test from "node:test";
import { keywordSimilarity } from "../utils/utils";

test("keyword similarity is case-insensitive and handles empty input", () => {
  assert.equal(keywordSimilarity("Peach Jamba", "peach jamba"), 1);
  assert.equal(keywordSimilarity("", "peach"), 0);
  assert.equal(keywordSimilarity("!!!", "peach"), 0);
});

test("keyword similarity favors related foods over unrelated foods", () => {
  const related = keywordSimilarity("peach jamba smoothie", "jamba peach smoothie");
  const unrelated = keywordSimilarity("peach jamba smoothie", "V8 tomato juice");

  assert.ok(related > unrelated);
  assert.ok(related > 0.8);
});
