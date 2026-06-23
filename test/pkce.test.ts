import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { base64url, generatePkce, randomState } from "../src/pkce.js";

describe("pkce", () => {
  it("generates an S256 verifier/challenge pair within RFC bounds", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // base64url charset only (no +, /, or =).
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge as base64url(SHA-256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("produces unique verifiers and states", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(randomState()).not.toBe(randomState());
  });
});
