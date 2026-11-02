import { describe, expect, it, vi } from 'vitest'
import { showPreparedAgentLaunchNotice } from './prepared-agent-launch-notice-ipc-bridge'

const { toastInfoMock } = vi.hoisted(() => ({ toastInfoMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

describe('prepared agent launch notice', () => {
  it('names the agent and what to do', () => {
    const closed = { operationId: 'op-1', worktreeId: 'wt-1', agent: 'codex' } as const
    showPreparedAgentLaunchNotice({ ...closed, kind: 'setup-ended' })
    showPreparedAgentLaunchNotice({ ...closed, operationId: 'op-2', kind: 'prompt-uncertain' })

    expect(toastInfoMock).toHaveBeenNthCalledWith(
      1,
      "Setup was closed before it finished, so Codex wasn't started. Start Codex from a new tab.",
      { id: 'prepared-agent-launch:op-1' }
    )
    expect(toastInfoMock).toHaveBeenNthCalledWith(
      2,
      'Codex started, but its first prompt may not have been delivered. Check Codex before sending the prompt again.',
      { id: 'prepared-agent-launch:op-2' }
    )
  })

  it('says what to do when the agent itself could not be started', () => {
    showPreparedAgentLaunchNotice({
      operationId: 'op-3',
      worktreeId: 'wt-1',
      agent: 'codex',
      kind: 'spawn-failed'
    })

    expect(toastInfoMock).toHaveBeenLastCalledWith(
      'Codex could not be started. Check the agent command in Settings, then start Codex from a new tab.',
      { id: 'prepared-agent-launch:op-3' }
    )
  })
})
