// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isTerminalLeafId, type TerminalLeafId } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { RecoveredSessionResumePortals } from './RecoveredSessionResumePortals'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const LEAF = '3c2b1a00-0000-4000-8000-000000000001'

function terminalLeaf(): TerminalLeafId {
  if (!isTerminalLeafId(LEAF)) {
    throw new Error('fixture leaf id is not a terminal leaf id')
  }
  return LEAF
}

function recoveryRecord(origin: SleepingAgentSessionRecord['origin']): SleepingAgentSessionRecord {
  return {
    paneKey: `tab-1:${LEAF}`,
    tabId: 'tab-1',
    worktreeId: 'repo::/wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    launchConfig: { agentArgs: '', agentEnv: {} },
    origin,
    restoreOnTabOpenOnly: false,
    ...(origin === 'recovery' ? { recovery: { importKey: 'key', sourcePaneKey: 'src:leaf' } } : {})
  }
}

describe('RecoveredSessionResumePortals', () => {
  const resumeLocal = vi.fn()

  beforeEach(() => {
    resumeLocal.mockReset().mockResolvedValue({
      terminalHandle: 'h',
      disposition: 'created',
      localPaneKey: `tab-1:${LEAF}`
    })
    Object.assign(window, {
      api: { crossMachineRecovery: { resumeLocal, onApply: vi.fn(), reply: vi.fn() } }
    })
  })
  afterEach(cleanup)

  function renderPortals(origin: SleepingAgentSessionRecord['origin']): void {
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [`tab-1:${LEAF}`]: recoveryRecord(origin) }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    render(
      <RecoveredSessionResumePortals
        panes={[{ id: 1, container, leafId: terminalLeaf() }]}
        tabId="tab-1"
        worktreeId="repo::/wt"
      />
    )
  }

  it('launches nothing until Resume is clicked, then resumes exactly once', () => {
    renderPortals('recovery')

    expect(screen.getByText('Recovered session')).toBeTruthy()
    expect(resumeLocal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    expect(resumeLocal).toHaveBeenCalledTimes(1)
    expect(resumeLocal).toHaveBeenCalledWith({
      worktreeId: 'repo::/wt',
      providerSessionId: 'session-1'
    })
  })

  it('offers no Resume for ordinary sleeping records', () => {
    renderPortals('worktree-sleep')

    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })
})
