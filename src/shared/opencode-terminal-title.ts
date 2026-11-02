// Why: wrappers may prepend an SSH/tmux label, and OpenCode may prepend one
// status glyph. A spinner-led task from another agent must not become a wrapper.
const OPENCODE_HEADER = String.raw`(?:[\u25A3\u2800-\u28ff] )?OC`
const OPENCODE_HEADER_RE = new RegExp(String.raw`^\s*${OPENCODE_HEADER} $`, 'u')
const OPENCODE_NATIVE_TITLE_RE = new RegExp(
  String.raw`^\s*(?:(?![\u25A3\u2800-\u28ff])[^|]+? \| )?${OPENCODE_HEADER} \|[ \t]+\S`,
  'u'
)

const OPENCODE_DIRECT_TITLE_RE = new RegExp(String.raw`^\s*${OPENCODE_HEADER} \|[ \t]+\S`, 'u')

export function isDirectOpenCodeNativeTitle(title: string): boolean {
  return OPENCODE_DIRECT_TITLE_RE.test(title)
}

export function isOpenCodeNativeTitleHeader(header: string): boolean {
  return OPENCODE_HEADER_RE.test(header)
}

export function isOpenCodeNativeTitle(title: string | null | undefined): boolean {
  return title ? OPENCODE_NATIVE_TITLE_RE.test(title) : false
}

export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  return isOpenCodeNativeTitle(title)
}
