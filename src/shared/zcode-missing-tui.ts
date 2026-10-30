/** ZCode’s desktop runtime can pass version/doctor/headless probes without @zcode/tui, then fail interactive launch. Detect the missing package to avoid reporting working hook setup as usable TUI support.
 * Recorded evidence: src/main/runtime/__fixtures__/zcode-missing-tui.txt. */

// Match Node resolution failures and ZCode wrappers that explicitly name the omitted package.
const ZCODE_MISSING_TUI_RE = /Cannot find (?:package|module) ['"]@zcode\/tui['"]/
const ZCODE_TUI_UNAVAILABLE_RE =
  /(?:TUI\s*(?:不可用|未提供|不可使用)|TUI\s+(?:is\s+)?(?:unavailable|not available))/i
const ZCODE_TUI_REQUIRES_INTERACTIVE_RE =
  /(?:TUI requires an interactive terminal\.|TUI 需要交互式终端。)/

/** Unknown means the probe could not determine support; callers must not classify that build as broken. */
export type ZCodeInteractiveCapability = 'interactive' | 'missing-tui' | 'unknown'

/** True when this output is ZCode reporting that its terminal UI is not installed. */
export function isZCodeMissingTuiOutput(output: string): boolean {
  return (
    ZCODE_MISSING_TUI_RE.test(output) ||
    (output.includes('@zcode/tui') && ZCODE_TUI_UNAVAILABLE_RE.test(output))
  )
}

/** The official TUI emits this only after its runtime loaded successfully and rejected piped stdio. */
export function isZCodeInteractiveTuiOutput(output: string): boolean {
  return ZCODE_TUI_REQUIRES_INTERACTIVE_RE.test(output)
}
