import { parseTmuxArgs, tmuxValue } from './claude-agent-teams-tmux-compat'

export type It2Command =
  | { kind: 'list' }
  | { kind: 'split'; vertical: boolean; sessionId: string | undefined }
  | { kind: 'send'; sessionId: string | undefined; text: string }
  | { kind: 'run'; sessionId: string | undefined; command: string }
  | { kind: 'close'; sessionId: string | undefined }

const TEAMMATE_MODE_ITERM2_RE = /(^|\s)--teammate-mode(?:=|\s+)iterm2(?:\s|$)/
// Why: Claude prunes a dead session only when `session list` stops containing its id as a substring, so no id may
// be a substring of another (`orca-pane-2` would hide inside `orca-pane-20`); the trailing word ends every number.
const IT2_SESSION_RE = /^orca-(\d+)-pane$/

export function requestsClaudeTeammateModeIterm2(launch: string): boolean {
  return TEAMMATE_MODE_ITERM2_RE.test(launch)
}

export function it2SessionIdForPane(fakePaneId: string): string {
  return `orca-${fakePaneId.replace(/^%/, '')}-pane`
}

export function fakePaneIdForIt2Session(sessionId: string): string | null {
  const match = IT2_SESSION_RE.exec(sessionId)
  return match ? `%${match[1]}` : null
}

// Why: Claude Code's iTerm2 backend only issues these `it2 session` verbs; anything else is a contract change worth failing loudly on.
export function parseIt2Command(argv: string[]): It2Command {
  const [group, action, ...rest] = argv
  if (group === 'session') {
    switch (action) {
      case 'list':
        return { kind: 'list' }
      case 'split': {
        const parsed = parseTmuxArgs(rest, ['-s'], ['-v'])
        return {
          kind: 'split',
          vertical: parsed.flags.has('-v'),
          sessionId: tmuxValue(parsed, '-s') || undefined
        }
      }
      case 'send': {
        const parsed = parseTmuxArgs(rest, ['-s'], [])
        return {
          kind: 'send',
          sessionId: tmuxValue(parsed, '-s') || undefined,
          text: parsed.positional.join(' ')
        }
      }
      case 'run': {
        const parsed = parseTmuxArgs(rest, ['-s'], [])
        return {
          kind: 'run',
          sessionId: tmuxValue(parsed, '-s') || undefined,
          command: parsed.positional.join(' ')
        }
      }
      case 'close': {
        const parsed = parseTmuxArgs(rest, ['-s'], ['-f'])
        return { kind: 'close', sessionId: tmuxValue(parsed, '-s') || undefined }
      }
    }
  }
  throw new Error(`unsupported it2 command: ${argv.join(' ')}`)
}
