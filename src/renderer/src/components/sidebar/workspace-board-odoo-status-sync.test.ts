import { describe, expect, it, vi } from 'vitest'

import {
  getMappedOdooStageName,
  matchingOdooStages,
  normalizeOdooStageName,
  syncOdooBoardStatuses,
  type OdooBoardStatusSyncDependencies,
  type SyncOdooBoardStatusArgs
} from './workspace-board-odoo-status-sync'
import type { OdooStage, OdooTicket } from '../../../../shared/odoo-types'
import type { WorkspaceStatusDefinition } from '../../../../shared/worktree/types'
function stage(id: number, name: string): OdooStage {
  return { id, name, sequence: id, fold: false }
}

const REVIEW: WorkspaceStatusDefinition = {
  id: 'in-review',
  label: 'In review',
  odooStageName: 'Review'
}

function ticket(overrides: Partial<OdooTicket> = {}): OdooTicket {
  return {
    id: 45514,
    ref: '#45514',
    title: 'Connecteur',
    url: 'https://odoo.example/45514',
    state: '01_in_progress',
    priority: '0',
    tags: [],
    assignees: [],
    project: { id: 8, name: 'NUTRI' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

type MockedDeps = {
  getTicket: ReturnType<typeof vi.fn>
  listStages: ReturnType<typeof vi.fn>
  updateTicket: ReturnType<typeof vi.fn>
}

function deps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    getTicket: vi.fn().mockResolvedValue(ticket()),
    listStages: vi.fn().mockResolvedValue([stage(1, 'À faire'), stage(2, 'Review')]),
    updateTicket: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
}

function asDeps(mocked: MockedDeps): Partial<OdooBoardStatusSyncDependencies> {
  return mocked as unknown as Partial<OdooBoardStatusSyncDependencies>
}

function args(overrides: Partial<SyncOdooBoardStatusArgs> = {}): SyncOdooBoardStatusArgs {
  return {
    worktreeIds: ['wt-1'],
    targetStatus: REVIEW,
    worktreesById: new Map([['wt-1', { linkedOdooTicket: 45514, linkedOdooInstanceId: 'prod' }]]),
    getSettingsForWorktree: () => undefined,
    getLatestWorkspaceStatus: () => 'in-review',
    ...overrides
  }
}

describe('normalizeOdooStageName', () => {
  it('ignores case, surrounding space and accents', () => {
    expect(normalizeOdooStageName('  En Cours  ')).toBe('en cours')
    expect(normalizeOdooStageName('À faire')).toBe(normalizeOdooStageName('a faire'))
  })
})

describe('matchingOdooStages', () => {
  const stages = [stage(1, 'Review'), stage(2, 'review'), stage(3, 'Done')]

  it('matches every stage sharing the name, so ambiguity stays visible', () => {
    expect(matchingOdooStages(stages, 'Review').map((s) => s.id)).toEqual([1, 2])
  })

  it('returns nothing for an unknown or blank name', () => {
    expect(matchingOdooStages(stages, 'Nope')).toEqual([])
    expect(matchingOdooStages(stages, '   ')).toEqual([])
  })
})

describe('getMappedOdooStageName', () => {
  it('treats blank or absent as unmapped', () => {
    expect(getMappedOdooStageName(REVIEW)).toBe('Review')
    expect(getMappedOdooStageName({ id: 'a', label: 'A' })).toBeNull()
    expect(getMappedOdooStageName({ id: 'a', label: 'A', odooStageName: '  ' })).toBeNull()
  })
})

describe('syncOdooBoardStatuses', () => {
  it('writes the resolved stage id for the linked ticket', async () => {
    const d = deps()
    const result = await syncOdooBoardStatuses({ ...args(), deps: asDeps(d) })
    expect(result.updated).toBe(1)
    expect(d.updateTicket).toHaveBeenCalledWith(undefined, 45514, { stageId: 2 }, 'prod')
  })

  it('skips a column with no mapped stage instead of guessing', async () => {
    const d = deps()
    const result = await syncOdooBoardStatuses({
      ...args({ targetStatus: { id: 'todo', label: 'Todo' } }),
      deps: asDeps(d)
    })
    expect(result.updated).toBe(0)
    expect(result.messages).toContainEqual({ kind: 'unmapped-status', statusLabel: 'Todo' })
    expect(d.getTicket).not.toHaveBeenCalled()
  })

  it('skips when no stage carries the configured name', async () => {
    const d = deps({ listStages: vi.fn().mockResolvedValue([stage(1, 'À faire')]) })
    const result = await syncOdooBoardStatuses({ ...args(), deps: asDeps(d) })
    expect(result.updated).toBe(0)
    expect(result.messages).toContainEqual({
      kind: 'missing-stage',
      statusLabel: 'In review',
      stageName: 'Review'
    })
  })

  it('refuses to choose between duplicate stage names', async () => {
    const d = deps({
      listStages: vi.fn().mockResolvedValue([stage(2, 'Review'), stage(3, 'review')])
    })
    const result = await syncOdooBoardStatuses({ ...args(), deps: asDeps(d) })
    expect(result.updated).toBe(0)
    expect(result.messages[0]).toMatchObject({ kind: 'ambiguous-stage' })
  })

  it('does not write when the ticket already sits in the target stage', async () => {
    const d = deps({ getTicket: vi.fn().mockResolvedValue(ticket({ stage: stage(2, 'Review') })) })
    const result = await syncOdooBoardStatuses({ ...args(), deps: asDeps(d) })
    expect(result.skipped).toBe(1)
    expect(d.updateTicket).not.toHaveBeenCalled()
  })

  it('drops a stale move when the board has moved on', async () => {
    const d = deps()
    const result = await syncOdooBoardStatuses({
      ...args({ getLatestWorkspaceStatus: () => 'done' }),
      deps: asDeps(d)
    })
    expect(result.skipped).toBe(1)
    expect(d.updateTicket).not.toHaveBeenCalled()
  })

  it('skips a workspace with no linked ticket', async () => {
    const d = deps()
    const result = await syncOdooBoardStatuses({
      ...args({ worktreesById: new Map([['wt-1', {}]]) }),
      deps: asDeps(d)
    })
    expect(result.skipped).toBe(1)
    expect(d.getTicket).not.toHaveBeenCalled()
  })

  it('reports a failed write', async () => {
    const d = deps({ updateTicket: vi.fn().mockResolvedValue({ ok: false, error: 'denied' }) })
    const result = await syncOdooBoardStatuses({ ...args(), deps: asDeps(d) })
    expect(result.failed).toBe(1)
    expect(result.messages[0]).toMatchObject({ kind: 'update-failed', detail: 'denied' })
  })
})
