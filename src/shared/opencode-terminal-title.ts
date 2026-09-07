// Why: wrappers may prepend an SSH/tmux label, and OpenCode may prepend one
// status glyph. A spinner-led task from another agent must not become a wrapper.
const OPENCODE_NATIVE_TITLE_RE =
  /^\s*(?:(?![▣\u2800-\u28ff])[^|]+? \| )?(?:[▣\u2800-\u28ff] )?OC \|[ \t]+\S/u

export function isOpenCodeNativeTitle(title: string | null | undefined): boolean {
  return title ? OPENCODE_NATIVE_TITLE_RE.test(title) : false
}

export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  return isOpenCodeNativeTitle(title)
}
