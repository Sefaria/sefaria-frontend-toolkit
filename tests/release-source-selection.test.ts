import { describe, expect, it } from "vitest";
import { assertReleaseSource } from "../scripts/npm-release.mjs";

describe("explicit numbered release source selection", () => {
  const source = "a".repeat(40);
  const main = "b".repeat(40);
  it("requires current main for new preparation", () => {
    expect(() =>
      assertReleaseSource({
        operation: "prepare",
        source,
        head: source,
        main,
        ancestor: true,
      }),
    ).toThrow();
  });
  it.each(["publish", "verify-finalize"])(
    "permits %s recovery from an explicitly pinned main ancestor",
    (operation) => {
      expect(() =>
        assertReleaseSource({
          operation,
          source,
          head: source,
          main,
          ancestor: true,
        }),
      ).not.toThrow();
      expect(() =>
        assertReleaseSource({
          operation,
          source,
          head: main,
          main,
          ancestor: true,
        }),
      ).toThrow();
      expect(() =>
        assertReleaseSource({
          operation,
          source,
          head: source,
          main,
          ancestor: false,
        }),
      ).toThrow();
    },
  );
});
