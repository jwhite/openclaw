// ha-voice plugin module implements core bridge behavior.
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";

/** Core config subset read by ha-voice helpers. */
export type CoreConfig = OpenClawConfig;

/** Agent runtime API subset exposed through the plugin SDK. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
