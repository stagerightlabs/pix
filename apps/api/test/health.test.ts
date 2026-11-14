import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("GET /health returns ok on the API host", async () => {
  const res = await SELF.fetch("https://pix-api.stagerightlabs.com/health");
  expect([res.status, await res.json()]).toEqual([200, { status: "ok" }]);
});
