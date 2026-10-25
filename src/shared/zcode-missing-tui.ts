/** ZCode’s desktop runtime can pass version/doctor/headless probes without @zcode/tui, then fail interactive launch. Detect the missing package to avoid reporting working hook setup as usable TUI support.
 * Recorded evidence: src/main/runtime/__fixtures__/zcode-missing-tui.txt. */

// Match Node’s unlocalized package/module resolution errors. A healthy build’s no-TTY message is localized and does not mean the TUI is missing.
const ZCODE_MISSING_TUI_RE = /Cannot find (?:package|module) ['"]@zcode\/tui['"]/

/** Unknown means the probe could not determine support; callers must not classify that build as broken. */
export type ZCodeInteractiveCapability = 'interactive' | 'missing-tui' | 'unknown'

/** True when this output is ZCode reporting that its terminal UI is not installed. */
export function isZCodeMissingTuiOutput(output: string): boolean {
  return ZCODE_MISSING_TUI_RE.test(output)
}
