import { describe, expect, it } from 'vitest'
import { parseAgentStatusParentInput } from './agent-status-store-parent'
import { TMUX_TEST_PANE, TMUX_TEST_ROOT } from './tmux-status.test-fixture'
const subject = { ...TMUX_TEST_ROOT.scope, kind: 'pty', paneKey: TMUX_TEST_PANE } as const

describe('canonical PTY attachment without a status claim', () => {
  it('retains the subject when its owner reports no selected status', () => {
    expect(parseAgentStatusParentInput({ subject })).toEqual({ subject })
  })
  it('still refuses a status claiming another pane', () => {
    expect(
      parseAgentStatusParentInput({
        subject,
        status: {
          paneKey: 'foreign',
          connectionId: null,
          worktreeId: 'workspace',
          state: 'done',
          prompt: '',
          receivedAt: 1,
          stateStartedAt: 1
        }
      })
    ).toBeNull()
  })
})
