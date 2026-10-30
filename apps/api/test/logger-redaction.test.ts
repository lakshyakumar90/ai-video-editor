import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createLogger,
  REDACT_CENSOR,
  REDACT_PATHS,
} from "../src/lib/logger.js";

function captureLog(): {
  log: (object: unknown) => void;
  lines(): string[];
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: "info", destination });
  return { log: (object) => logger.info(object), lines: () => chunks };
}

describe("logger redaction", () => {
  it("redacts secret-bearing fields at the top level", () => {
    const capture = captureLog();
    capture.log({
      authorization: "Bearer sk-secret",
      apiKey: "sk-123",
      "x-api-key": "sk-456",
    });

    const output = capture.lines().join("");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("sk-123");
    expect(output).not.toContain("sk-456");
    expect(output).toContain(REDACT_CENSOR);
  });

  it("redacts secret-bearing fields one level deep", () => {
    const capture = captureLog();
    capture.log({
      body: {
        apiKey: "sk-deep",
        authorization: "Bearer sk-deep-auth",
        "x-api-key": "sk-deep-header",
      },
    });

    const output = capture.lines().join("");
    expect(output).not.toContain("sk-deep");
    expect(output).toContain(REDACT_CENSOR);
  });

  it("redacts the authorization header from a logged request", () => {
    const capture = captureLog();
    capture.log({
      req: {
        method: "POST",
        url: "/api/uploads",
        headers: {
          authorization: "Basic b3BlbmNvZGU6cGFzc3dvcmQ=",
          "x-api-key": "sk-user-key",
          "content-type": "application/octet-stream",
        },
      },
    });

    const output = capture.lines().join("");
    expect(output).not.toContain("b3BlbmNvZGU6cGFzc3dvcmQ=");
    expect(output).not.toContain("sk-user-key");
    expect(output).toContain('"content-type":"application/octet-stream"');
  });

  it("redacts Better Auth cookies on requests and responses", () => {
    const capture = captureLog();
    capture.log({
      req: { headers: { cookie: "better-auth.session_token=secret-session" } },
      res: {
        headers: { "set-cookie": ["better-auth.session_token=secret-session"] },
      },
    });
    const output = capture.lines().join("");
    expect(output).not.toContain("secret-session");
    expect(output).toContain(REDACT_CENSOR);
  });

  it("leaves non-secret fields untouched", () => {
    const capture = captureLog();
    capture.log({
      provider: "opencode",
      model: "flint-40b-free",
      apiKey: "sk-x",
    });

    const output = capture.lines().join("");
    expect(output).toContain("opencode");
    expect(output).toContain("flint-40b-free");
  });

  it("covers every secret field name in the redact path list", () => {
    const coverage = new Set<string>(["authorization", "apiKey", "x-api-key"]);
    const seen = new Set<string>();
    for (const path of REDACT_PATHS) {
      const lastSegments = path.split(/[.[\]]+/).filter(Boolean);
      const leaf = lastSegments[lastSegments.length - 1];
      if (leaf) seen.add(leaf);
    }
    for (const name of coverage) {
      expect(seen.has(name), `REDACT_PATHS is missing a path for ${name}`).toBe(
        true,
      );
    }
  });
});
