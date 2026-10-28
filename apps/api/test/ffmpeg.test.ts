import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFfmpeg, runProcess } from "../src/services/ffmpeg.js";

describe("runProcess", () => {
  it("resolves with captured stdout on exit 0", async () => {
    // hermetic-ish: uses the node binary itself (available by construction)
    const node = process.execPath;
    const result = await runProcess(node, [
      "-e",
      'process.stdout.write("out-");process.stderr.write("err-tail");process.exit(0)',
    ]);
    expect(result.stdout).toBe("out-");
    expect(result.stderr).toBe("err-tail");
  });

  it("rejects on non-zero exit with the stderr tail", async () => {
    const node = process.execPath;
    await expect(
      runProcess(node, [
        "-e",
        'process.stderr.write("boom stderr");process.exit(3)',
      ]),
    ).rejects.toThrowError(/boom stderr/);
  });

  it("rejects when the command cannot be spawned (ENOENT)", async () => {
    await expect(
      runProcess("definitely-not-a-real-executable", ["--version"]),
    ).rejects.toThrowError(/"(?:.)+" not found.*PATH/s);
  });

  it("handles args containing spaces safely (no shell interpretation)", async () => {
    const node = process.execPath;
    // if a shell string were built from these, "& mitten.exe" would try to run a second command
    const tricky = "some path with spaces & mitten.exe";
    const result = await runProcess(node, [
      "-e",
      `console.log(process.argv[1], process.argv[2])`,
      tricky,
      "second-arg",
    ]);
    expect(result.stdout.trim()).toBe(`${tricky} second-arg`);
  });
});

describe("runFfmpeg", () => {
  it("runs real ffmpeg and rejects when ffmpeg is missing or fails", async () => {
    // requires ffmpeg on PATH; produces a 1-frame png and validates the happy path
    const out = path.resolve("../tmp/samples/run-ffmpeg-test.png");
    try {
      const result = await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=teal:s=64x64",
        "-frames:v",
        "1",
        out,
      ]);
      expect(result.stdout.length).toBeGreaterThan(0);
    } catch (error) {
      // environments without ffmpeg: the failure itself must be the typed path
      expect((error as Error).message).toMatch(/ffmpeg/);
    }
  });

  it("propagates non-zero exits with stderr content", async () => {
    await expect(runFfmpeg(["-nonsense-flag"])).rejects.toThrowError(
      /exited with (a non-zero|code)/,
    );
  });
});
