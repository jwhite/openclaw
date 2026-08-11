import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { broadcastChatFinal } from "./chat-broadcast.js";

describe("global chat broadcast ownership", () => {
  it("keeps the bare global subscription for its persisted fixed-store owner", () => {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const context = {
      agentRunSeq: new Map<string, number>(),
      broadcast,
      getRuntimeConfig: () =>
        ({
          session: { scope: "global", store: "/stores/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
        }) satisfies OpenClawConfig,
      nodeSendToSession,
    };

    broadcastChatFinal({
      context,
      runId: "run-ops-global",
      sessionKey: "global",
      agentId: "ops",
    });

    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
      { sessionKeys: ["agent:ops:global", "global"] },
    );
    expect(nodeSendToSession.mock.calls.map(([key]) => key)).toEqual([
      "agent:ops:global",
      "global",
    ]);
  });
});
