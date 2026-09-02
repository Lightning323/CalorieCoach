
import stringSimilarity from "string-similarity";

/**
 * Calculate the similarity between two strings, based on the fuzzy matching algorithm used by string-similarity.
 * This function normalizes the input strings by converting them to lowercase and removing non-alphanumeric characters.
 * It then splits the normalized strings into words and calculates the similarity between each pair of words.
 * The final score is the sum of all the similarity scores for each pair of words, normalized to a range of 0-1.
 * @param {string} a The first string to compare.
 * @param {string} b The second string to compare.
 * @returns {number} A value between 0 and 1 indicating the similarity between the two strings.
 */
export function keywordSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;

  const normalizeWords = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean);

  const wordsA = normalizeWords(a);
  const wordsB = normalizeWords(b);

  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const normalizedA = wordsA.join(" ");
  const normalizedB = wordsB.join(" ");

  // Exact phrase or phrase contained in a longer database entry.
  if (
    normalizedA === normalizedB ||
    normalizedB.includes(normalizedA)
  ) {
    return 1;
  }

  // Each input word can contribute only once.
  const bestScoreForEachInputWord = wordsA.map((inputWord) =>
    Math.max(
      ...wordsB.map((databaseWord) =>
        stringSimilarity.compareTwoStrings(inputWord, databaseWord)
      )
    )
  );

  const wordScore =
    bestScoreForEachInputWord.reduce((sum, score) => sum + score, 0) /
    wordsA.length;

  const phraseScore = stringSimilarity.compareTwoStrings(
    normalizedA,
    normalizedB
  );

  // Word matching is primary; full phrase similarity breaks close ties.
  return wordScore * 0.8 + phraseScore * 0.2;
}