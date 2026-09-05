// Public ha-control API barrel exposed to plugin-local modules and tests.

export {
  definePluginEntry,
  jsonResult,
  resolveConfiguredSecretInputString,
  stringEnum,
  type AnyAgentTool,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "./runtime-api.js";
