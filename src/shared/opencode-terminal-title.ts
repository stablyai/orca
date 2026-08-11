// Why: OpenCode abbreviates native OSC session titles as `OC | <task>` (no
// agent-name token). Optional single-token multiplexer prefix covers SSH/tmux
// frames like `tmux | OC | …`. Case-sensitive `OC` avoids ordinary lowercase
// "oc" lookalikes; require non-whitespace after the marker so bare `OC |` is not
// identity. Used for both display-title preservation and tab-agent identity.
const OPENCODE_NATIVE_TITLE_RE = /^(?:[^|\s]+ \| )?OC\s*\|\s*\S/u

export function isOpenCodeNativeTitle(title: string | null | undefined): boolean {
  return OPENCODE_NATIVE_TITLE_RE.test(title?.trim() ?? '')
}

export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  return isOpenCodeNativeTitle(title)
}
