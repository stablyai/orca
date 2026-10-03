import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  redmineConnect,
  redmineGetIssue,
  redmineListIssues,
  redmineStatus,
  redmineTestConnection
} from './runtime-redmine-client'
import type { RedmineIssue } from '../../../shared/redmine-types'

const { callRuntimeRpc, getActiveRuntimeTarget } = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc, getActiveRuntimeTarget }))

function remoteTarget() {
  return { kind: 'environment', environmentId: 'env-1' }
}
function localTarget() {
  return { kind: 'local' }
}

let windowApiRedmine!: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  ;(windowApiRedmine as Record<string, ReturnType<typeof vi.fn>>) = {
    status: vi.fn(),
    testConnection: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listIssues: vi.fn(),
    getIssue: vi.fn()
  }
  vi.stubGlobal('window', { api: { redmine: windowApiRedmine } })
})

const issue: RedmineIssue = {
  id: 1,
  subject: 'Fix the thing',
  project: { id: 1, name: 'Orca' },
  tracker: { id: 1, name: 'Bug' },
  status: { id: 1, name: 'New' },
  priority: { id: 1, name: 'Normal' },
  author: { id: 1, name: 'Ada', login: 'ada' },
  assignedTo: null,
  description: null,
  startDate: null,
  dueDate: null,
  doneRatio: 0,
  estimatedHours: null,
  spentHours: null,
  createdOn: '2026-01-01T00:00:00Z',
  updatedOn: '2026-01-01T00:00:00Z',
  closedOn: null,
  customFields: [],
  url: 'https://redmine.example.com/issues/1'
}

describe('redmineListIssues', () => {
  it('uses window.api on a local runtime and normalizes the result', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.listIssues.mockResolvedValue({ items: [issue], totalCount: 1 })

    const result = await redmineListIssues(null, { scope: 'assigned' })

    expect(windowApiRedmine.listIssues).toHaveBeenCalledWith({ filter: { scope: 'assigned' } })
    expect(result).toEqual({ items: [issue], totalCount: 1 })
  })

  it('routes through runtime RPC on a remote environment', async () => {
    getActiveRuntimeTarget.mockReturnValue(remoteTarget())
    callRuntimeRpc.mockResolvedValue({ items: [issue], totalCount: 1 })

    const result = await redmineListIssues(null, { scope: 'assigned' })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      remoteTarget(),
      'redmine.listIssues',
      { filter: { scope: 'assigned' } },
      expect.objectContaining({ timeoutMs: 30_000 })
    )
    expect(result.items).toHaveLength(1)
  })

  it('normalizes a malformed payload to an empty collection', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.listIssues.mockResolvedValue(null)

    const result = await redmineListIssues(null)
    expect(result).toEqual({ items: [], totalCount: 0 })
  })
})

describe('redmineStatus / getIssue', () => {
  it('reads status from window.api locally', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.status.mockResolvedValue({ connected: true })
    const status = await redmineStatus(null)
    expect(status).toEqual({ connected: true })
  })

  it('reads a single issue from window.api locally', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.getIssue.mockResolvedValue({ issue })
    const result = await redmineGetIssue(null, 1)
    expect(windowApiRedmine.getIssue).toHaveBeenCalledWith({ issueId: 1 })
    expect(result.issue?.id).toBe(1)
  })

  it('routes getIssue through runtime RPC remotely', async () => {
    getActiveRuntimeTarget.mockReturnValue(remoteTarget())
    callRuntimeRpc.mockResolvedValue({ issue })
    const result = await redmineGetIssue(null, 2)
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      remoteTarget(),
      'redmine.getIssue',
      { issueId: 2 },
      expect.anything()
    )
    expect(result.issue?.id).toBe(1)
  })

  it('normalizes a malformed getIssue payload to issue:null', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.getIssue.mockResolvedValue(null)
    const result = await redmineGetIssue(null, 1)
    expect(result).toEqual({ issue: null })
  })
})

describe('connect flows select the right transport', () => {
  it('testConnection hits window.api locally', async () => {
    getActiveRuntimeTarget.mockReturnValue(localTarget())
    windowApiRedmine.testConnection.mockResolvedValue({
      ok: true,
      user: { id: 1, name: 'Ada', login: 'ada' }
    })
    const result = await redmineTestConnection(null, { siteUrl: 'https://x.example', apiKey: 'k' })
    expect(windowApiRedmine.testConnection).toHaveBeenCalledWith({
      siteUrl: 'https://x.example',
      apiKey: 'k'
    })
    expect(result.ok).toBe(true)
  })

  it('connect routes through runtime RPC remotely', async () => {
    getActiveRuntimeTarget.mockReturnValue(remoteTarget())
    callRuntimeRpc.mockResolvedValue({ ok: true })
    await redmineConnect(null, { siteUrl: 'https://x.example', apiKey: 'k' })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      remoteTarget(),
      'redmine.connect',
      { siteUrl: 'https://x.example', apiKey: 'k' },
      expect.anything()
    )
  })
})
