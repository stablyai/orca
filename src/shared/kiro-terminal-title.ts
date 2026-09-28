/**
 * Kiro's TUI writes `kiro: <session title | ~/cwd>` as its OSC 0 title (only
 * once `chat.terminalTitle` is on — see kiro-terminal-title-setting.ts).
 *
 * The `kiro: ` prefix is the vendor marker: Kiro owns the whole string, so the
 * session text after it may name any other agent without changing whose pane
 * this is. Anchored at the start, past at most one Orca/ssh/tmux wrapper
 * segment, so a task title that merely mentions Kiro never mints an identity.
 */
const KIRO_NATIVE_TITLE_RE = /^\s*(?:(?![▣⠀-⣿])[^|]+? \| )?kiro:[ \t]+(\S.*?)\s*$/u

export function isKiroNativeTitle(title: string | null | undefined): boolean {
  return title ? KIRO_NATIVE_TITLE_RE.test(title) : false
}

/**
 * What Kiro writes after the marker: the session title, or the working
 * directory when the session has not been named yet. Callers that want a
 * conversation name must reject the cwd form themselves — this only parses.
 */
export function getKiroNativeTitleSessionText(title: string | null | undefined): string | null {
  return (title ? KIRO_NATIVE_TITLE_RE.exec(title)?.[1] : null) ?? null
}
