// Why: Codex 0.147+ OSC titles are `{cwd} | Ready|Starting|Working|Thinking | {thread}`.
// They name no `codex` token, so title-derived sidebar rows vanished until the
// first UserPromptSubmit — same class as OpenCode's `OC |` marker.

const CODEX_NATIVE_STATUS = 'Ready|Starting|Working|Thinking'
const CODEX_NATIVE_SESSION_TITLE_RE = new RegExp(
  String.raw`^\s*(?:[\u2800-\u28FF]+\s+)?(?!OC\b)[^|\n]+ \| (?:${CODEX_NATIVE_STATUS}) \| \S`,
  'u'
)
const CODEX_NATIVE_STATUS_RE = new RegExp(
  String.raw`(?:^|\| )(${CODEX_NATIVE_STATUS}) \| `
)

export function isCodexNativeSessionTitle(title: string | null | undefined): boolean {
  return title ? CODEX_NATIVE_SESSION_TITLE_RE.test(title) : false
}

export function getCodexNativeSessionStatus(
  title: string | null | undefined
): 'idle' | 'working' | null {
  if (!title || !isCodexNativeSessionTitle(title)) {
    return null
  }
  const status = CODEX_NATIVE_STATUS_RE.exec(title)?.[1]
  return status === 'Ready' ? 'idle' : 'working'
}
