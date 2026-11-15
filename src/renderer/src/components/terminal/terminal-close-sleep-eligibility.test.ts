import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { captureWorktreeSleepResumeRecords } from '../../../../main/runtime/terminal/stop/worktree-sleep-resume-records'
import { canSleepInsteadOfClosingTab } from './terminal-close-sleep-eligibility'

const worktrees = vi.hoisted(() => new Map<string, { id: string; hostId?: string }>())
vi.mock('@/store/github/refresh/worktree-refresh', () => ({
  findWorktreeById: (_state: unknown, id: string) => worktrees.get(id) ?? null
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`
const SESSION = { key: 'session_id', id: 'claude-session-1' } as const

function stateWith(entry: Record<string, unknown>, vmWorkspace = false): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the eligibility check reads only these three slices; a renamed slice fails the test.
  return {
    agentStatusByPaneKey: new Map([[PANE_KEY, entry]]),
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } },
    ephemeralVmRuntimesByWorkspaceId: vmWorkspace ? { 'wt-1': { id: 'vm-1' } } : {}
  } as unknown as AppState
}

function eligible(state: AppState): boolean {
  return canSleepInsteadOfClosingTab(state, {
    worktreeId: 'wt-1',
    terminalTabId: 'tab-1',
    busyPtyIds: ['pty-1']
  })
}

// Main's own capture for the same hook row: what sleep would persist for this pane.
async function mainPersistsResumeRecord(row: Record<string, unknown>): Promise<boolean> {
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId: 'wt-1',
    paneKeysByPtyId: new Map([['pty-1', [PANE_KEY]]]),
    launchByPtyId: new Map(),
    readRowsForPane: () => [
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows mimic hook payloads, including ones missing a session, which the capture must tolerate.
      { paneKey: PANE_KEY, connectionId: null, receivedAt: 1, ...row } as AgentStatusIpcPayload
    ],
    checkAgentPresence: null,
    capturedAt: 2
  })
  const records = capture.get('pty-1')?.records ?? []
  return records.some(
    (record) => record.providerSession.id === SESSION.id && record.restoreOnTabOpenOnly === true
  )
}

describe('canSleepInsteadOfClosingTab', () => {
  it('offers sleep exactly when main would persist a resume record for the busy agent', async () => {
    worktrees.set('wt-1', { id: 'wt-1' })
    const resumable = { agentType: 'claude', providerSession: SESSION }
    expect(eligible(stateWith(resumable))).toBe(true)
    expect(await mainPersistsResumeRecord(resumable)).toBe(true)

    const noSession = { agentType: 'claude' }
    expect(eligible(stateWith(noSession))).toBe(false)
    expect(await mainPersistsResumeRecord(noSession)).toBe(false)

    const notResumable = { agentType: 'aider', providerSession: SESSION }
    expect(eligible(stateWith(notResumable))).toBe(false)
    expect(await mainPersistsResumeRecord(notResumable)).toBe(false)
  })

  it('offers sleep on SSH workspaces but not on paired servers or VM workspaces', () => {
    const resumable = { agentType: 'claude', providerSession: SESSION }
    worktrees.set('wt-1', { id: 'wt-1', hostId: 'ssh:devbox-2' })
    expect(eligible(stateWith(resumable))).toBe(true)

    worktrees.set('wt-1', { id: 'wt-1', hostId: 'runtime:env-1' })
    expect(eligible(stateWith(resumable))).toBe(false)

    worktrees.set('wt-1', { id: 'wt-1' })
    expect(eligible(stateWith(resumable, true))).toBe(false)
  })
})
