import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("BYOK routes", () => {
  it("requires a Better Auth session even if the request supplies a userId", async () => {
    const response = await request(createApp())
      .put("/api/providers/keys")
      .send({
        userId: "attacker-controlled",
        providerId: "openai",
        apiKey: "secret",
      });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { message: "Authentication required" },
    });
  });

  it("uses the Better Auth session owner for encrypted key records", async () => {
    const app = createApp();
    const signup = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "LLM test",
        email: `llm-${randomUUID()}@example.test`,
        password: "a-long-test-password",
      });
    expect(signup.status).toBe(200);
    const cookieHeader = signup.headers["set-cookie"];
    const cookies = Array.isArray(cookieHeader)
      ? cookieHeader
      : cookieHeader
        ? [cookieHeader]
        : [];
    const fakeProbe = await request(app)
      .post("/api/providers/test")
      .set("Cookie", cookies)
      .send({ providerId: "fake" });
    expect(fakeProbe.status).toBe(200);
    expect(fakeProbe.body).toMatchObject({ ok: true, providerId: "fake" });
    const missingKey = await request(app)
      .post("/api/providers/test")
      .set("Cookie", cookies)
      .send({ providerId: "openai" });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error).toMatch(/no API key is configured/);
    const saved = await request(app)
      .put("/api/providers/keys")
      .set("Cookie", cookies)
      .send({
        userId: "forged-user",
        providerId: "openai",
        apiKey: "sk-test-session-1234",
      });
    expect(saved.status).toBe(200);
    expect(saved.body.key).toMatchObject({
      providerId: "openai",
      lastFour: "1234",
    });
    expect(JSON.stringify(saved.body)).not.toContain("sk-test-session-1234");
    const listed = await request(app)
      .get("/api/providers/keys")
      .set("Cookie", cookies);
    expect(listed.body.keys).toEqual([
      expect.objectContaining({ providerId: "openai", lastFour: "1234" }),
    ]);
    const previousRoute = process.env.LLM_TASK_SCRIPT_PLANNING;
    process.env.LLM_TASK_SCRIPT_PLANNING = "fake";
    try {
      const plan = await request(app)
        .post("/api/llm/scene-plan")
        .set("Cookie", cookies)
        .send({ prompt: "A short Tokyo travel video" });
      expect(plan.status).toBe(200);
      expect(plan.body.scenes).toHaveLength(3);
    } finally {
      if (previousRoute === undefined)
        delete process.env.LLM_TASK_SCRIPT_PLANNING;
      else process.env.LLM_TASK_SCRIPT_PLANNING = previousRoute;
    }
  });
});
