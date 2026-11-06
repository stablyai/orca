import { describe, expect, it } from 'vitest'
import { recognizeAgentProcessFromCommandLine } from './agent-status/process/agent-process-recognition'
import { getAgentRowConversationName } from './agent-status/presentation/agent-row-conversation-name'
import { agentToolsLackTerminalHandle } from './agent-launch/catalog/tui-agent-terminal-handle'

// `aiwork tui` leaves aiwork-tui in the foreground as `aiwork-tui aiwork <cwd> --agent <id> --dtcoder-bin <path> [-y]`.
describe('AiWork process recognition', () => {
  it.each([
    'aiwork tui -y',
    'aiworkcn tui -y',
    'aiworkcli resume --last',
    'aiwork resume --last',
    '/opt/aiwork/bin/aiwork-tui aiwork /tmp/project --agent coder-tui --dtcoder-bin /opt/aiwork/bin/aiwork -y'
  ])('treats %s as the interactive AiWork TUI', (line) => {
    expect(recognizeAgentProcessFromCommandLine(line)?.agent).toBe('aiwork')
  })

  it.each(['aiwork chat "summarize this repo"', 'aiworkcn chat hi', 'aiwork-tui --once'])(
    'does not claim interactive ownership for one-shot %s',
    (line) => {
      expect(recognizeAgentProcessFromCommandLine(line)).toBeNull()
      expect(
        recognizeAgentProcessFromCommandLine(line, { includeHeadlessOneShot: true })?.agent
      ).toBe('aiwork')
    }
  )
})

// Recorded titles: `AiWork | <session>` at rest and during approvals, `⠙ AiWork | <session> — <activity>` while busy.
describe('AiWork titles', () => {
  it.each([
    '⠙ AiWork | Fix running tests — Waiting for model',
    '● ⠙ AiWork | Fix running tests — Running bash',
    '● AiWork | Fix running tests'
  ])('names the row after the session in %s', (title) => {
    expect(getAgentRowConversationName({ customTitle: null, title }, 'aiwork', false)).toBe(
      'Fix running tests'
    )
  })
})

describe('AiWork tool environment', () => {
  it('is the agent whose mail pointers name the terminal', () => {
    expect(agentToolsLackTerminalHandle('aiwork')).toBe(true)
    expect(agentToolsLackTerminalHandle('claude')).toBe(false)
    expect(agentToolsLackTerminalHandle(null)).toBe(false)
  })
})
