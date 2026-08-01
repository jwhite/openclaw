/**
 * Best-effort voice-command diary write to MemPalace (S2.2).
 *
 * Opens a short-lived MCP client per call rather than a persistent connection: one write per
 * voice turn is rare enough (seconds apart at most) that connection reuse isn't worth the
 * complexity, and a fresh connection means a MemPalace outage can never leave a stale/half-open
 * session behind. Must never affect the voice response path — callers fire this without
 * awaiting it, and every failure is caught and logged, never thrown.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const DIARY_WING = "ha_voice";
const DIARY_ROOM = "diary";
const CONNECT_TIMEOUT_MS = 5_000;
export function formatDiaryContent(params) {
    const timestamp = new Date(params.timestampMs).toISOString();
    const device = params.deviceId ? ` (device: ${params.deviceId})` : "";
    return `[${timestamp}]${device} Voice: "${params.said}" → Response: "${params.response}"`;
}
export async function writeVoiceDiaryEntry(params) {
    const client = new Client({ name: "ha-voice", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(params.mempalaceUrl));
    try {
        await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(() => reject(new Error("MemPalace connect timed out")), CONNECT_TIMEOUT_MS)),
        ]);
        await client.callTool({
            name: "mempalace_add_drawer",
            arguments: {
                wing: DIARY_WING,
                room: DIARY_ROOM,
                content: formatDiaryContent(params),
                added_by: "ha-voice",
            },
        });
    }
    catch (err) {
        params.logger.warn(`[ha-voice] MemPalace diary write failed (non-fatal): ${String(err)}`);
    }
    finally {
        await client.close().catch(() => { });
    }
}
