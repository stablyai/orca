export type PluginSources = {
  claudeAgentViewSource?: string
  opencodeStartupPromptSource?: string
  /** Empty string revokes future installs; omission preserves the cached source. */
  opencodePluginSource?: string
  /** Source body of OpenCode 2's status plugin. */
  opencode2PluginSource?: string
  /** Source body of Pi's `orca-agent-status.ts` to drop into <overlay>/extensions/. */
  piExtensionSource?: string
  /** Source body of OMP's `orca-agent-status.ts` to drop into <overlay>/extensions/. */
  ompExtensionSource?: string
  /** Source body of Prime Agent's `orca-agent-status.ts` to install in its real agent dir. */
  primeAgentExtensionSource?: string
}
/** Result of installing Pi-compatible status into a real agent home or OMP fallback path. */
export type MaterializePiResult = {
  /** Real agent dir when extensions were installed there. Absent for OMP status-only fallback. */
  sourceAgentDir?: string
  /** Absolute path to orca-agent-status.ts (real home or relay-managed fallback). */
  statusExtensionPath?: string
}
