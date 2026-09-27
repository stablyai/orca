// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { isTerminalLeafId, type TerminalLeafId } from '../../../../shared/stable-pane-id'
import { onDormantRecoveryPaneShellRelease } from '@/lib/dormant-recovery-shell-release'
import { useAppStore } from '@/store'
import { RecoveredSessionResumePortals } from './RecoveredSessionResumePortals'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const LEAF = '3c2b1a00-0000-4000-8000-000000000001'
const BINDING = { agent: 'claude', key: 'session_id', id: 'session-1' }

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
  const releaseLocal = vi.fn()

  beforeEach(() => {
    releaseLocal.mockReset().mockResolvedValue({ released: BINDING })
    resumeLocal.mockReset().mockResolvedValue({
      terminalHandle: 'h',
      disposition: 'created',
      localPaneKey: `tab-1:${LEAF}`
    })
    Object.assign(window, {
      api: {
        crossMachineRecovery: { resumeLocal, releaseLocal, onApply: vi.fn(), reply: vi.fn() }
      }
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
    expect(resumeLocal).toHaveBeenCalledWith({ worktreeId: 'repo::/wt', binding: BINDING })
  })

  it('releases the binding, then its pane, on Start shell instead', async () => {
    const paneReleased = vi.fn()
    const stopListening = onDormantRecoveryPaneShellRelease(`tab-1:${LEAF}`, paneReleased)
    renderPortals('recovery')

    fireEvent.click(screen.getByRole('button', { name: 'Start shell instead' }))

    expect(releaseLocal).toHaveBeenCalledWith({ worktreeId: 'repo::/wt', binding: BINDING })
    await vi.waitFor(() => expect(paneReleased).toHaveBeenCalledTimes(1))
    expect(resumeLocal).not.toHaveBeenCalled()
    stopListening()
  })

  it('keeps the pane held when the release fails', async () => {
    releaseLocal.mockRejectedValue(new Error('recovery_binding_not_found'))
    const paneReleased = vi.fn()
    const stopListening = onDormantRecoveryPaneShellRelease(`tab-1:${LEAF}`, paneReleased)
    renderPortals('recovery')

    fireEvent.click(screen.getByRole('button', { name: 'Start shell instead' }))

    await vi.waitFor(() => expect(releaseLocal).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(paneReleased).not.toHaveBeenCalled()
    stopListening()
  })

  it('stacks into wrapping full-width actions when its pane is narrow', () => {
    renderPortals('recovery')

    expect(screen.getByTestId('recovered-session-placeholder').className.split(' ')).toEqual(
      expect.arrayContaining(['@container/recovered-session', 'max-h-full', 'overflow-y-auto'])
    )
    expect(screen.getByTestId('recovered-session-placeholder-card').className.split(' ')).toEqual(
      expect.arrayContaining([
        'flex-wrap',
        '@max-md/recovered-session:flex-col',
        '@max-md/recovered-session:items-stretch',
        '@max-md/recovered-session:self-stretch'
      ])
    )
    expect(screen.getByText('Recovered session').className.split(' ')).toContain('wrap-anywhere')
    for (const name of ['Resume', 'Start shell instead']) {
      const button = screen.getByRole('button', { name })
      expect(button.className.split(' ')).toContain('h-auto')
      expect(button.className.split(' ')).not.toContain('h-8')
      expect(within(button).getByText(name).className.split(' ')).toEqual(
        expect.arrayContaining(['whitespace-normal', 'wrap-anywhere'])
      )
    }
  })

  it('offers no Resume for ordinary sleeping records', () => {
    renderPortals('worktree-sleep')

    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })
})
