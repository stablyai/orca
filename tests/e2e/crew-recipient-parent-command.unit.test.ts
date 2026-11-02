import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { partialRuntimeStore } from '../../src/main/runtime/runtime-store-partial-fixture'
import { RuntimeClientError } from '../../src/cli/runtime-client'
import { releaseAgentSessionRecordStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-slot'
import { createOrdinaryCrewCommandFixture } from './crew-recipient-public-command.test-fixture'
const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(async () => {
  const remaining = await releaseAgentSessionRecordStore()
  remaining?.journalDatabase.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('executes the actual published Managed by address after its genuine foreign parent reports done', async () => {
  const f = createOrdinaryCrewCommandFixture(hostRef)
  const rawRpc: unknown[] = []
  const actualDispatch = f.dispatcher.dispatch.bind(f.dispatcher)
  vi.spyOn(f.dispatcher, 'dispatch').mockImplementation(async (...args) => {
    const response = await actualDispatch(...args)
    rawRpc.push({ request: args[0], response })
    return response
  })
  try {
    Object.defineProperty(f.runtime, 'store', {
      value: partialRuntimeStore({ getSettings: () => ({ nestedWorkerMaxDepth: 4 }) })
    })
    vi.mocked(f.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      ['term_peer', 'term_helper', 'term_worker'].includes(handle)
        ? {
            runtimeId: f.runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: `pty_${handle}`,
            worktreeId: 'folder-worker-host',
            paneKey: f.panes.get(handle)!,
            processIncarnation: `process:${handle}`,
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
    vi.spyOn(f.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(f.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder-worker-host',
      repoId: 'repo',
      displayName: 'worker',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: '/tmp',
      head: 'fixture',
      branch: 'fixture',
      isBare: false,
      isMainWorktree: true,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: '/tmp',
        head: 'fixture',
        branch: 'fixture',
        isBare: false,
        isMainWorktree: true
      }
    })
    vi.spyOn(f.runtime, 'showTerminal').mockImplementation(async (handle) => ({
      handle,
      worktreeId: 'folder-worker-host',
      worktreePath: '/tmp',
      branch: 'fixture',
      tabId: f.panes.get(handle)!.split(':')[0]!,
      leafId: f.panes.get(handle)!.split(':')[1]!,
      title: 'worker',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: 1,
      ptyId: `pty_${handle}`,
      rendererGraphEpoch: 1
    }))
    const handles = ['term_peer', 'term_helper', 'term_worker']
    const create = vi.spyOn(f.runtime, 'createTerminal').mockImplementation(async () => {
      const handle = handles.shift()
      if (!handle) {
        throw new Error('unexpected fourth terminal creation')
      }
      return { handle, worktreeId: 'folder-worker-host', title: 'worker' }
    })
    vi.spyOn(f.runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(f.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const prompt = vi
      .spyOn(f.runtime, 'sendTerminalAgentPrompt')
      .mockImplementation(async (handle) => ({
        handle,
        accepted: true,
        bytesWritten: 1
      }))
    const agent = vi.spyOn(f.runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(f.runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    const started: { dispatchId: string; taskId: string; state: 'ready' }[] = []
    await f.command('term_coord', 'run-create', [['objective', 'foreign parent advertised action']])
    const run = f.db.getCurrentRunForPane(f.panes.get('term_coord')!)
    if (!run) {
      throw new Error('actual run-create missing')
    }
    for (const from of ['term_coord', 'term_peer', 'term_helper']) {
      await f.command(from, 'worker-start', [
        ['spec', `fresh helper from ${from}`],
        ['agent', 'codex'],
        ['worktree', 'id:folder-worker-host']
      ])
      started.push(
        z
          .object({ dispatchId: z.string(), taskId: z.string(), state: z.literal('ready') })
          .parse(
            f.receipts.findLast((entry) => entry.method === 'orchestration.workerStart')?.result
          )
      )
    }
    const [w2, h, w1] = started
    if (!w2 || !h || !w1) {
      throw new Error('genuine start chain missing')
    }
    expect(new Set(started.map((item) => item.dispatchId)).size).toBe(3)
    expect(new Set(started.map((item) => item.taskId)).size).toBe(3)
    for (const [index, handle] of ['term_peer', 'term_helper', 'term_worker'].entries()) {
      const worker = started[index]!
      expect(f.db.getDispatchContextById(worker.dispatchId)).toMatchObject({
        run_id: run.id,
        depth: index + 1,
        assignee_handle: handle,
        creator_dispatch_id: index === 0 ? null : started[index - 1]!.dispatchId
      })
      expect(f.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
      expect(f.db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
        owner_dispatch_id: worker.dispatchId,
        terminal_handle: handle,
        process_incarnation: `process:${handle}`,
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
      expect(f.db.getCurrentRunForPane(f.panes.get(handle)!)).toBeUndefined()
    }
    expect(create).toHaveBeenCalledTimes(3)
    expect(prompt).toHaveBeenCalledTimes(3)
    await f.command('term_helper', 'send', [
      ['to', `dispatch:${w2.dispatchId}`],
      ['subject', 'parent H reports done while W1 works'],
      ['type', 'worker_done'],
      ['task-id', h.taskId],
      ['dispatch-id', h.dispatchId],
      ['outcome', 'succeeded'],
      ['body', 'H explicitly done']
    ])
    const settlementReceipt = f.receipts.findLast(
      (entry) => entry.method === 'orchestration.send'
    )?.result
    expect(settlementReceipt).toMatchObject({
      lifecycle: { action: 'completed', dispatchId: h.dispatchId }
    })
    expect(f.db.getDispatchContextById(h.dispatchId)?.status).toBe('completed')
    expect(f.db.getWorkerDispatch(h.dispatchId)?.state).toBe('succeeded')
    for (const worker of [w2, w1]) {
      expect(f.db.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')
      expect(f.db.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
    }
    const live = {
      pane: f.runtime.getLiveTerminalPaneKey('term_helper'),
      process: f.runtime.getTerminalProcessIncarnation('term_helper'),
      agent: await f.runtime.isTerminalRunningAgent('term_helper')
    }
    expect(live).toEqual({
      pane: f.panes.get('term_helper'),
      process: 'process:term_helper',
      agent: true
    })
    expect(f.db.getWorkerTerminalResourceByOwner(h.dispatchId)).toMatchObject({
      terminal_handle: 'term_helper',
      process_incarnation: live.process,
      owner_dispatch_id: h.dispatchId,
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    const snapshot = f.runtime.getOrchestrationCrewSnapshot('term_worker')
    const row = snapshot.sections.managedBy.find(
      (item) => item.openTarget?.kind === 'terminal' && item.openTarget.handle === 'term_helper'
    )
    expect(row).toMatchObject({ openTarget: { kind: 'terminal', handle: 'term_helper' } })
    expect(row?.sendAddress).toBe('term_helper')
    expect(create).toHaveBeenCalledTimes(3)
    expect(prompt).toHaveBeenCalledTimes(3)
    expect(agent).toHaveBeenCalledTimes(1)
    if (!row?.sendAddress) {
      throw new Error('actual Managed by address absent; no manufactured address sent')
    }
    const freeze = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (_key, item: unknown) =>
          typeof item === 'function' ? '[runtime callback]' : item
        )
      )
    const effects = () =>
      freeze({
        tasks: f.db.db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        dispatches: f.db.db.prepare('SELECT * FROM dispatch_contexts ORDER BY id').all(),
        workers: f.db.db.prepare('SELECT * FROM worker_dispatches ORDER BY dispatch_id').all(),
        resources: f.db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all(),
        mailDeliveryNotifications: f.effects(),
        creates: create.mock.calls,
        prompts: prompt.mock.calls
      })
    const delivered = f.effects()
    await f.send('term_worker', row.sendAddress, 'actual published foreign parent action')
    expect(
      f.mail().filter((item) => item.subject === 'actual published foreign parent action')
    ).toEqual([
      expect.objectContaining({
        from_handle: 'term_worker',
        to_handle: 'term_helper',
        run_id: run.id
      })
    ])
    const afterDelivery = f.effects()
    expect(afterDelivery.delivery).toHaveLength(delivered.delivery.length + 1)
    expect(afterDelivery.notify).toHaveLength(delivered.notify.length + 1)
    const before = effects()
    const rpcCount = rawRpc.length
    let refusal: unknown
    try {
      await f.send('term_worker', `dispatch:${h.dispatchId}`, 'explicit foreign parent refused')
    } catch (error) {
      refusal =
        error instanceof RuntimeClientError
          ? { name: error.name, code: error.code, message: error.message }
          : String(error)
    }
    const after = effects()
    const refusalRpc = rawRpc.slice(rpcCount)
    expect(refusal).toMatchObject({
      code: 'task_not_found',
      message: expect.stringContaining(
        `Dispatch ${h.dispatchId} is not a helper of Dispatch ${w1.dispatchId}`
      )
    })
    expect(refusalRpc).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          response: expect.objectContaining({
            ok: false,
            error: expect.objectContaining({
              code: 'task_not_found',
              data: expect.objectContaining({ effectsApplied: false })
            })
          })
        })
      ])
    )
    expect(after).toEqual(before)
  } finally {
    f.close()
  }
})
