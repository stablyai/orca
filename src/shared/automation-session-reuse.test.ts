import { describe, expect, it } from 'vitest'
import type { AutomationRun } from './automations-types'
import { findReusableAutomationRun } from './automation-session-reuse'

function run(overrides: Partial<AutomationRun>): AutomationRun {
  const createdAt = overrides.createdAt ?? 1
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'Workspace',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: 'tab-1:leaf-1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: createdAt,
    dispatchedAt: createdAt,
    createdAt,
    ...overrides
  }
}

function find(
  runs: AutomationRun[],
  options: {
    status?: { state: string; agentType?: string }
    livePtyIds?: string[]
  } = {}
): string | null {
  const livePtyIds = new Set(options.livePtyIds ?? runs.map((entry) => entry.terminalPtyId))
  const statusesByPaneKey = new Map(
    runs.map((entry) => [
      entry.terminalPaneKey,
      options.status ?? { state: 'done', agentType: 'claude' }
    ])
  )
  return findReusableAutomationRun({
    automationId: 'auto-1',
    agentId: 'claude',
    worktreeId: 'wt-1',
    target: { hostId: 'local', repoId: 'repo-1', path: '/repo' },
    currentRunId: 'run-current',
    runs,
    agentStatusForPane: (paneKey) => statusesByPaneKey.get(paneKey),
    liveSession: (candidate) => (livePtyIds.has(candidate.terminalPtyId) ? candidate.id : null)
  })
}

describe('automation session reuse selection', () => {
  it('picks the newest completed run of this automation in this workspace', () => {
    expect(
      find([
        run({ id: 'run-old', terminalPaneKey: 'tab-old:leaf-1', createdAt: 1 }),
        run({ id: 'run-new', createdAt: 2 }),
        run({ id: 'run-current', status: 'dispatching', createdAt: 3 }),
        run({ id: 'run-other-automation', automationId: 'auto-2', createdAt: 4 }),
        run({
          id: 'run-other-workspace',
          workspaceId: 'wt-2',
          terminalPaneKey: 'tab-wt-2:leaf-1',
          createdAt: 5
        })
      ])
    ).toBe('run-new')
  })

  it('falls back to an older run when the newer one no longer holds its PTY', () => {
    expect(
      find(
        [
          run({
            id: 'run-old',
            terminalPaneKey: 'tab-old:leaf-1',
            terminalPtyId: 'pty-old',
            createdAt: 1
          }),
          run({ id: 'run-new', createdAt: 2 })
        ],
        { livePtyIds: ['pty-old'] }
      )
    ).toBe('run-old')
  })

  it('orders panes by dispatch, not creation: a run created first may dispatch last', () => {
    // run-early waited in its precheck while run-late dispatched into the pane and finished.
    expect(
      find([
        run({ id: 'run-late', createdAt: 2, dispatchedAt: 3 }),
        run({ id: 'run-early', status: 'dispatch_failed', createdAt: 1, dispatchedAt: 4 })
      ])
    ).toBeNull()
    expect(
      find([
        run({ id: 'run-early', createdAt: 1, dispatchedAt: 4 }),
        run({ id: 'run-late', status: 'dispatch_failed', createdAt: 2, dispatchedAt: 3 })
      ])
    ).toBe('run-early')
  })

  it('never picks a pane whose newest run is still working in it', () => {
    expect(
      find([
        run({ id: 'run-done', createdAt: 1 }),
        run({ id: 'run-working', status: 'dispatched', createdAt: 2 })
      ])
    ).toBeNull()
  })

  it('never picks an older record of a pane a newer run since used', () => {
    expect(
      find([
        run({ id: 'run-done', createdAt: 1 }),
        run({ id: 'run-reused-failed', status: 'dispatch_failed', createdAt: 2 })
      ])
    ).toBeNull()
  })

  it('does not reuse legacy runs without exact pane and PTY identity', () => {
    expect(find([run({ terminalPaneKey: null })])).toBeNull()
    expect(find([run({ terminalPtyId: null })])).toBeNull()
  })

  it.each([
    ['a working agent', { state: 'working', agentType: 'claude' }],
    ['another agent', { state: 'done', agentType: 'codex' }]
  ])('rejects a pane holding %s', (_label, status) => {
    expect(find([run({})], { status })).toBeNull()
  })

  it('accepts an idle agent whose type the host could not tell', () => {
    expect(find([run({})], { status: { state: 'done', agentType: 'unknown' } })).toBe('run-1')
    expect(find([run({})], { status: { state: 'done' } })).toBe('run-1')
  })
})
