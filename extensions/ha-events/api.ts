// Public ha-events API barrel exposed to plugin-local modules and tests.

export {
  definePluginEntry,
  resolveConfiguredSecretInputString,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "./runtime-api.js";
