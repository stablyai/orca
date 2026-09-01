// @vitest-environment happy-dom
/**
 * Proves a workspace-board status move writes `stage_id` on a real Odoo server,
 * through the shipped resolution path rather than a restatement of it:
 * `useWorkspaceStatusProviderSync` → `syncOdooBoardStatuses` →
 * `runtime-odoo-client` → `src/main/odoo/tickets.ts`.
 *
 * Why it lives next to the hook instead of in `src/main/odoo/`: driving the real
 * hook pulls the renderer store graph, which needs the DOM lib types only the
 * web TypeScript project loads.
 *
 * Opt-in and credential-free: set ODOO_PROOF_URL / _DB / _LOGIN / _KEY against a
 * disposable instance. Unset, the suite skips so CI stays green.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { renderHook } from '@testing-library/react'

import { connect, getClients } from '../../../../main/odoo/client'
import { executeKw, type OdooClientForInstance } from '../../../../main/odoo/json-rpc'
import { installOdooLiveProofHostPorts } from '../../../../main/odoo/live-proof-host-ports'
import { getTicket, listStages, updateTicket } from '../../../../main/odoo/tickets'
import { normalizeInstanceId, normalizeRecordId } from '../../../../main/ipc/odoo-ipc-args'
import { useWorkspaceStatusProviderSync } from './use-workspace-status-provider-sync'
import { useAppStore } from '@/store'
import { normalizeWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { WORKTREE_ID_SEPARATOR } from '../../../../shared/worktree/id'
import type { OdooTicketUpdate } from '../../../../shared/odoo-types'
import type { Worktree, WorkspaceStatus } from '../../../../shared/worktree/types'

const TICKET_ID = Number(process.env.ODOO_PROOF_CHILD_TICKET ?? '80')
const PROJECT_ID = Number(process.env.ODOO_PROOF_PROJECT ?? '7')
const REPO_ID = 'odoo-proof-board-repo'
const BRANCH = `odoo/${TICKET_ID}-empty-password`
// Nothing on the synced path touches the filesystem, so the workspace is a store
// record rather than a real checkout.
const WORKTREE_PATH = '/odoo-proof-board/ticket'
const WORKTREE_ID = `${REPO_ID}${WORKTREE_ID_SEPARATOR}${WORKTREE_PATH}`

const LIVE = Boolean(process.env.ODOO_PROOF_URL)

// The board columns this proof maps onto the project's stages, built through the
// shipped normalizer so the `odooStageName` sanitizer runs for real.
const WORKSPACE_STATUSES = normalizeWorkspaceStatuses([
  { id: 'todo', label: 'Todo', odooStageName: 'New' },
  { id: 'in-progress', label: 'In progress', odooStageName: 'In Progress' },
  { id: 'in-review', label: 'In review', odooStageName: 'To Validate' },
  { id: 'completed', label: 'Done', odooStageName: 'Done' }
])

let instanceId = ''
let client: OdooClientForInstance

/** Re-reads from the server until `predicate` holds, so nothing passes optimistically. */
async function pollServer<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await read()
  }
  return last
}

function stageIdFor(stages: readonly { id: number; name: string }[], name: string): number {
  const match = stages.find((stage) => stage.name === name)
  if (!match) {
    throw new Error(`stage "${name}" missing on project ${PROJECT_ID}`)
  }
  return match.id
}

/**
 * Stands in for the preload bridge. Mirrors the `odoo:getTicket`,
 * `odoo:listStages` and `odoo:updateTicket` handlers in src/main/ipc/odoo.ts,
 * reusing their exported argument normalizers, so the renderer half of the path
 * runs against the same main-process functions the app calls.
 */
function installPreloadOdooBridge(): void {
  const api = {
    odoo: {
      getTicket: async (args: { id: number; instanceId?: string }) => {
        const id = normalizeRecordId(args?.id)
        return id === null ? null : getTicket(id, normalizeInstanceId(args.instanceId))
      },
      listStages: async (args: { projectId: number; instanceId?: string }) => {
        const projectId = normalizeRecordId(args?.projectId)
        return projectId === null ? [] : listStages(projectId, normalizeInstanceId(args.instanceId))
      },
      updateTicket: async (args: {
        id: number
        updates: OdooTicketUpdate
        instanceId?: string
      }) => {
        const id = normalizeRecordId(args?.id)
        if (id === null) {
          return { ok: false, error: 'Ticket ID is required.' }
        }
        return updateTicket(id, args.updates, normalizeInstanceId(args.instanceId))
      }
    }
  }
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
}

function storeWorktree(status: WorkspaceStatus): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: REPO_ID,
    path: WORKTREE_PATH,
    head: '0000000000000000000000000000000000000000',
    branch: BRANCH,
    isBare: false,
    isMainWorktree: false,
    displayName: `#${TICKET_ID}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedOdooTicket: TICKET_ID,
    linkedOdooInstanceId: instanceId,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: Date.now(),
    workspaceStatus: status
  }
}

function seedStore(status: WorkspaceStatus): void {
  useAppStore.setState({
    worktreesByRepo: { [REPO_ID]: [storeWorktree(status)] },
    workspaceStatuses: WORKSPACE_STATUSES,
    syncTaskStatusFromWorkspaceBoard: true
  })
}

describe.skipIf(!LIVE)('Odoo board status sync', () => {
  beforeAll(async () => {
    // Inside the skipped describe so a non-live run leaves the process-wide ports alone.
    installOdooLiveProofHostPorts()
    const result = await connect({
      serverUrl: process.env.ODOO_PROOF_URL as string,
      database: process.env.ODOO_PROOF_DB as string,
      login: process.env.ODOO_PROOF_LOGIN as string,
      apiKey: process.env.ODOO_PROOF_KEY as string
    })
    expect(result.ok, `connect failed: ${result.ok ? '' : result.error}`).toBe(true)
    const clients = getClients()
    expect(clients.length).toBeGreaterThan(0)
    client = clients[0]
    instanceId = client.instance.id
    installPreloadOdooBridge()

    // Start from the scenario's opening stage so the run is repeatable rather
    // than dependent on what a previous run left behind.
    const stages = await listStages(PROJECT_ID)
    const reset = await updateTicket(TICKET_ID, { stageId: stageIdFor(stages, 'New') })
    expect(reset.ok, reset.ok ? '' : reset.error).toBe(true)
  }, 120_000)

  it('step 4 — moving the workspace status writes stage_id on the server', async () => {
    const stages = await listStages(PROJECT_ID)
    const expected = {
      todo: stageIdFor(stages, 'New'),
      'in-progress': stageIdFor(stages, 'In Progress'),
      completed: stageIdFor(stages, 'Done')
    }

    const before = await getTicket(TICKET_ID)
    expect(before?.stage?.id, 'ticket did not start in New').toBe(expected.todo)

    const moved: { status: string; stageId?: number; stageName?: string }[] = []
    for (const [from, to] of [
      ['todo', 'in-progress'],
      ['in-progress', 'completed']
    ] as const) {
      seedStore(from)
      const { result } = renderHook(() => useWorkspaceStatusProviderSync())
      // Mirrors WorkspaceKanbanDrawer.moveWorktreeToStatus: the callback closed
      // over the pre-move worktree snapshot, then the local-first status write
      // lands, then the callback runs.
      const sync = result.current
      seedStore(to)
      sync([WORKTREE_ID], to)

      const ticket = await pollServer(
        () => getTicket(TICKET_ID),
        (value) => value?.stage?.id === expected[to]
      )
      expect(ticket?.stage?.id, `move to ${to} did not land`).toBe(expected[to])
      moved.push({ status: to, stageId: ticket?.stage?.id, stageName: ticket?.stage?.name })
    }

    // Read the raw record too: `getTicket` maps stage_id, so confirm the column
    // itself moved rather than trusting the mapper.
    const raw = await executeKw<Record<string, unknown>[]>(
      client,
      'project.task',
      'read',
      [[TICKET_ID]],
      { fields: ['stage_id'] }
    )
    const rawStage = raw[0]?.stage_id as [number, string] | undefined
    expect(rawStage?.[0]).toBe(expected.completed)
    console.log('STEP4 PROOF', JSON.stringify({ expected, moved, rawStage }))
  }, 180_000)

  it('step 4 control — an unmapped board column never writes a stage', async () => {
    useAppStore.setState({
      worktreesByRepo: { [REPO_ID]: [storeWorktree('completed')] },
      // Same columns, but "In review" no longer names an Odoo stage.
      workspaceStatuses: normalizeWorkspaceStatuses([
        { id: 'completed', label: 'Done', odooStageName: 'Done' },
        { id: 'in-review', label: 'In review' }
      ]),
      syncTaskStatusFromWorkspaceBoard: true
    })
    const { result } = renderHook(() => useWorkspaceStatusProviderSync())
    const sync = result.current
    useAppStore.setState({ worktreesByRepo: { [REPO_ID]: [storeWorktree('in-review')] } })
    // Why read rather than assume Done: this control must fail only when an
    // unmapped column moves the ticket, not because a filtered run skipped the
    // preceding test that put it there.
    const before = await getTicket(TICKET_ID)
    sync([WORKTREE_ID], 'in-review')

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const ticket = await getTicket(TICKET_ID)
    expect(ticket?.stage?.id, 'unmapped column moved the ticket anyway').toBe(before?.stage?.id)
    console.log('STEP4 CONTROL PROOF', JSON.stringify({ stayedOn: ticket?.stage }))
  }, 90_000)
})
