/**
 * The serializer keeps trailing background-only rows (a TUI that paints its
 * whole screen, e.g. OpenCode), so screens read as text end in `\r\n\x1b[NX`
 * rows. Every text reader of `serialize({ scrollback: 0 })` must read the same
 * thing with and without them.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'
import { agentInputLineCleared } from './native-chat-launch-draft-send'
import { buildBoundedSessionTranscript } from '@/lib/agent-session-fork-context'

const CLAUDE_FRAME = [
  '╭─ Claude Code ───╮',
  '│Haiku 4.5│',
  '│API Usage Billing│',
  '│C:\\work\\repo│',
  '╰─────────────╯',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────'
].join('\r\n')

async function serializedScreen(paintBackgroundBelow: boolean): Promise<string> {
  const terminal = new Terminal({ cols: 40, rows: 14, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  const below = paintBackgroundBelow ? '\x1b[s\x1b[9;1H\x1b[48;5;236m\x1b[J\x1b[0m\x1b[u' : ''
  await new Promise<void>((resolve) =>
    terminal.write(`\x1b[?1049h\x1b[H${CLAUDE_FRAME}\x1b[7;3H${below}`, resolve)
  )
  const screen = serializer.serialize({ scrollback: 0 })
  terminal.dispose()
  return screen
}

describe('text readers of a serialized screen with trailing background rows', () => {
  it('read the same model, prompt state and transcript as without them', async () => {
    const plain = await serializedScreen(false)
    const painted = await serializedScreen(true)
    // Precondition: the painted screen really carries the kept background rows.
    expect(painted).toContain(`\r\n\x1b[48;5;236m\x1b[40X${'\r\n\x1b[40X'.repeat(5)}`)

    expect(readClaudeSessionOptionsFromTerminalScreen(painted)).toEqual({ model: 'haiku' })
    expect(readClaudeSessionOptionsFromTerminalScreen(painted)).toEqual(
      readClaudeSessionOptionsFromTerminalScreen(plain)
    )
    expect(agentInputLineCleared(painted)).toBe(true)
    expect(agentInputLineCleared(painted)).toBe(agentInputLineCleared(plain))
    expect(buildBoundedSessionTranscript(painted)).toBe(buildBoundedSessionTranscript(plain))
  })
})
