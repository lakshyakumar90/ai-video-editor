import { describe, expect, it } from "vitest";
import {
  editBatchSchema,
  editOperationSchema,
  type EditOperation,
} from "../src/index.js";

describe("editOperationSchema", () => {
  const cases: Array<{
    name: string;
    operation: EditOperation;
  }> = [
    { name: "trim", operation: { kind: "trim", clipId: "clip-1", duration: 2 } },
    { name: "split", operation: { kind: "split", clipId: "clip-1", at: 4.5 } },
    { name: "delete", operation: { kind: "delete", clipId: "clip-1" } },
    {
      name: "move",
      operation: { kind: "move", clipId: "clip-1", start: 10, trackId: "track-video" },
    },
    {
      name: "replaceClip",
      operation: { kind: "replaceClip", clipId: "clip-1", assetId: "asset-2" },
    },
    {
      name: "setText",
      operation: { kind: "setText", clipId: "clip-1", text: "Hello" },
    },
    { name: "setVolume", operation: { kind: "setVolume", clipId: "clip-1", volume: 0.5 } },
    { name: "setSpeed", operation: { kind: "setSpeed", clipId: "clip-1", speed: 2 } },
    {
      name: "addCaptions",
      operation: {
        kind: "addCaptions",
        words: [{ word: "Hello", start: 0, end: 1 }],
        start: 0,
      },
    },
    {
      name: "removeSilence",
      operation: {
        kind: "removeSilence",
        clipId: "clip-1",
        ranges: [{ start: 1.5, end: 3 }],
      },
    },
    {
      name: "reframe",
      operation: {
        kind: "reframe",
        clipId: "clip-1",
        region: { x: 0, y: 0, width: 0.5, height: 0.5 },
      },
    },
  ];

  it.each(cases)("accepts the $name operation", ({ operation }) => {
    const result = editOperationSchema.safeParse(operation);
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("rejects an unknown operation kind", () => {
    const result = editOperationSchema.safeParse({ kind: "rewind", clipId: "clip-1" });
    expect(result.success).toBe(false);
  });

  it("rejects operations without the required target id", () => {
    const result = editOperationSchema.safeParse({ kind: "delete" });
    expect(result.success).toBe(false);
  });

  it("rejects setVolume above unity", () => {
    const result = editOperationSchema.safeParse({
      kind: "setVolume",
      clipId: "clip-1",
      volume: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reframe region escaping the source frame", () => {
    const result = editOperationSchema.safeParse({
      kind: "reframe",
      clipId: "clip-1",
      region: { x: 0.9, y: 0.9, width: 0.5, height: 0.5 },
    });
    expect(result.success).toBe(false);
  });
});

describe("editBatchSchema", () => {
  it("accepts an ordered batch of operations", () => {
    const result = editBatchSchema.safeParse({
      operations: [
        { kind: "split", clipId: "clip-1", at: 4.5 },
        { kind: "setSpeed", clipId: "clip-1", speed: 1.5 },
        { kind: "delete", clipId: "clip-2" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty batch", () => {
    const result = editBatchSchema.safeParse({ operations: [] });
    expect(result.success).toBe(false);
  });
});
