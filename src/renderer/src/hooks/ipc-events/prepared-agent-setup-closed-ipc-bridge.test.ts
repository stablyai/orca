import { describe, expect, it, vi } from 'vitest'
import { showPreparedAgentSetupClosedNotice } from './prepared-agent-setup-closed-ipc-bridge'

const { toastInfoMock } = vi.hoisted(() => ({ toastInfoMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { info: toastInfoMock } }))

describe('prepared agent Setup closed notice', () => {
  it('shows one short notice that names the agent and what to do', () => {
    showPreparedAgentSetupClosedNotice({ worktreeId: 'wt-1', agent: 'codex' })
    showPreparedAgentSetupClosedNotice({ worktreeId: 'wt-1', agent: 'codex' })

    expect(toastInfoMock).toHaveBeenCalledWith(
      "Setup was closed before it finished, so Codex wasn't started. Start Codex from a new tab.",
      { id: 'prepared-agent-setup-closed:wt-1' }
    )
    // A repeat for the same workspace replaces the toast instead of stacking another.
    expect(new Set(toastInfoMock.mock.calls.map(([, options]) => options.id)).size).toBe(1)
  })
})
