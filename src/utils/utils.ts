
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

    const normalizeWords = (s: string) =>
        s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, "")
            .split(/\s+/)
            .filter(Boolean);

    const wordsA = normalizeWords(a);
    const wordsB = normalizeWords(b);

    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    let score = 0;

    for (const wa of wordsA) {
        for (const wb of wordsB) {
            // use stringSimilarity for fuzzy comparison
            const similarity = stringSimilarity.compareTwoStrings(wa, wb); // 0–1
            score += similarity; // add the fuzzy score
        }
    }

    // Normalize score to 0–1 range
    const maxPossible = wordsA.length; // using wordsA as the denominator
    return Math.min(score / maxPossible, 1);
}