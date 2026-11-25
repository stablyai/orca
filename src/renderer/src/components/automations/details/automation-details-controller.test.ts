import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'
import type { AutomationOwnerContinuity } from '../hosts/automation-host-owner'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import { AutomationDetailsController } from './automation-details-controller'
import {
  AutomationMutationBusyError,
  AutomationOwnerChangedError,
  automationActionOutcomeUnknown,
  type AutomationDetailsDeps
} from './automation-details-model'

const OWNER: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 1 },
  selector: { kind: 'self' }
}
const controllers: AutomationDetailsController[] = []
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
})

function automation(patch: Partial<Automation> = {}): Automation {
  return makeAutomation({ id: 'a1', name: 'Digest', ...patch })
}

function run(id: string, createdAt: number): AutomationRun {
  return makeRun({ id, automationId: 'a1', title: id, createdAt })
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<AutomationDetailsDeps> = {}, runId: string | null = null) {
  const shows: Deferred<Automation>[] = []
  const pages: Deferred<AutomationRunsPage>[] = []
  let continuity: AutomationOwnerContinuity = { status: 'same', owner: OWNER }
  const deps: AutomationDetailsDeps = {
    showAutomation: vi.fn(() => {
      const next = deferred<Automation>()
      shows.push(next)
      return next.promise
    }),
    listRunsPage: vi.fn(() => {
      const next = deferred<AutomationRunsPage>()
      pages.push(next)
      return next.promise
    }),
    readRun: vi.fn(async (): Promise<AutomationRunRead> => ({ kind: 'run-missing' })),
    evaluateOwner: () => continuity,
    ...overrides
  }
  const controller = new AutomationDetailsController(OWNER, 'a1', 5, deps, runId)
  controllers.push(controller)
  return {
    controller,
    deps,
    shows,
    pages,
    setContinuity: (next: AutomationOwnerContinuity) => {
      continuity = next
    }
  }
}

describe('AutomationDetailsController reads', () => {
  it('keeps an acknowledged run across a pre-start reply and failed follow-up read', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    await h.controller.startRun(async () => ({ ...run('acknowledged', 20), status: 'dispatched' }))
    h.pages[0].resolve({ runs: [run('before-start', 10)], nextCursor: null })
    await flush()
    h.pages[1].reject(new Error('offline'))
    await flush()
    expect(h.controller.getSnapshot().runs).toMatchObject({ status: 'ready', stale: true })
    expect(h.controller.getSnapshot().runs.value.map(({ id, status }) => ({ id, status }))).toEqual(
      [{ id: 'acknowledged', status: 'dispatched' }]
    )
  })

  it('preserves paged boundary rows when new runs shift the first page and removes covered deletions', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    h.pages[0].resolve({
      runs: [10, 9, 8, 7, 6].map((id) => run(String(id), id)),
      nextCursor: 'cursor-6'
    })
    await flush()
    h.controller.loadMore()
    h.pages[1].resolve({ runs: [5, 4, 3, 2, 1].map((id) => run(String(id), id)), nextCursor: null })
    await flush()
    h.controller.reload()
    h.pages[2].resolve({
      runs: [11, 10, 9, 8, 7].map((id) => run(String(id), id)),
      nextCursor: 'cursor-7'
    })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map(({ id }) => id)).toEqual([
      '11',
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1'
    ])
    h.controller.reload()
    h.pages[3].resolve({
      runs: [11, 10, 9, 7, 6].map((id) => run(String(id), id)),
      nextCursor: 'cursor-6'
    })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map(({ id }) => id)).toEqual([
      '11',
      '10',
      '9',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1'
    ])
    expect(h.controller.getSnapshot().runs.nextCursor).toBeNull()
  })

  it('keeps the server cursor order for paged rows whose creation times tie', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: ['aa', 'bb', 'cc', 'dd', 'ee'].map((id) => run(id, 10)),
      nextCursor: '10:ee'
    })
    await flush()
    h.controller.loadMore()
    h.pages[1].resolve({ runs: [run('ff', 10)], nextCursor: null })
    await flush()
    h.controller.reload()
    h.pages[2].resolve({
      runs: [run('new', 11), ...['aa', 'bb', 'cc', 'dd'].map((id) => run(id, 10))],
      nextCursor: '10:dd'
    })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map(({ id }) => id)).toEqual([
      'new',
      'aa',
      'bb',
      'cc',
      'dd',
      'ee',
      'ff'
    ])
  })

  it('keeps the running acknowledgement when its full reply exceeds retained payload admission', async () => {
    const h = harness()
    await h.controller.startRun(async () => ({
      ...run('oversized-ack', 20),
      status: 'dispatched',
      outputSnapshot: {
        format: 'plain_text',
        content: 'x'.repeat(20 * 1024 * 1024),
        capturedAt: 1,
        truncated: false
      }
    }))
    expect(h.controller.getSnapshot().acknowledgedRun).toEqual({
      id: 'oversized-ack',
      status: 'dispatched'
    })
    expect(h.controller.getSnapshot().runs.value).toEqual([])
    h.pages[0].resolve({
      runs: [{ ...run('oversized-ack', 20), status: 'completed' }],
      nextCursor: null
    })
    await flush()
    expect(h.controller.getSnapshot().acknowledgedRun).toBeNull()
  })
  it('keeps the definition when the runs read fails, and the runs when the definition fails', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    h.pages[0].reject(new Error('runs down'))
    await flush()
    let snapshot = h.controller.getSnapshot()
    expect(snapshot.definition.status).toBe('ready')
    expect(snapshot.runs.status).toBe('error')
    expect(snapshot.runs.error?.message).toBe('runs down')

    h.controller.reload()
    h.shows[1].reject(new Error('settings down'))
    h.pages[1].resolve({ runs: [run('r1', 10)], nextCursor: null })
    await flush()
    snapshot = h.controller.getSnapshot()
    // A failed re-read keeps the last good definition, marked stale.
    expect(snapshot.definition).toMatchObject({ status: 'ready', stale: true })
    expect(snapshot.definition.value?.name).toBe('Digest')
    expect(snapshot.runs.value.map((r) => r.id)).toEqual(['r1'])
  })

  it('reports a missing automation as deleted, not as an error', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].reject(new Error('Automation not found: a1'))
    await flush()
    expect(h.controller.getSnapshot().definition.status).toBe('deleted')
  })

  it('cuts an old host that ignored the limit to the newest rows', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: Array.from({ length: 30 }, (_, index) => run(`r${index}`, index)),
      nextCursor: null
    })
    await flush()
    const ids = h.controller.getSnapshot().runs.value.map((r) => r.id)
    expect(ids).toEqual(['r29', 'r28', 'r27', 'r26', 'r25'])
  })
})

describe('AutomationDetailsController mutation fence', () => {
  it('never shows a read issued before a successful pause', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation({ enabled: true }))
    await flush()
    // A change event re-reads; that read is still on the wire when the pause lands.
    h.controller.reload()
    const pause = h.controller.mutate(
      async () => automation({ enabled: false, updatedAt: 1 }),
      (next) => next
    )
    await pause
    expect(h.controller.getSnapshot().definition.value?.enabled).toBe(false)
    // The old read answers "enabled" with the same timestamp: dropped, no clock compared.
    h.shows[1].resolve(automation({ enabled: true, updatedAt: 1 }))
    await flush()
    expect(h.controller.getSnapshot().definition.value?.enabled).toBe(false)
    // The reconcile read after the mutation is accepted, so later external changes converge.
    h.shows[2].resolve(automation({ enabled: true, updatedAt: 2 }))
    await flush()
    expect(h.controller.getSnapshot().definition.value?.enabled).toBe(true)
  })

  it('runs one definition change at a time', async () => {
    const h = harness()
    h.controller.start()
    const slow = deferred<Automation>()
    const first = h.controller.mutate(
      () => slow.promise,
      (next) => next
    )
    await expect(
      h.controller.mutate(
        async () => automation(),
        (next) => next
      )
    ).rejects.toBeInstanceOf(AutomationMutationBusyError)
    slow.resolve(automation())
    await first
  })

  it('does not restore a retired definition when an in-flight save finishes', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    await flush()
    const saved = deferred<Automation>()
    const saving = h.controller.mutate(
      () => saved.promise,
      (next) => next
    )
    const rejected = expect(saving).rejects.toBeInstanceOf(AutomationOwnerChangedError)
    h.setContinuity({ status: 'retired' })
    h.controller.recheckOwner()
    saved.resolve(automation({ name: 'Old computer' }))
    await rejected
    expect(h.controller.getSnapshot()).toMatchObject({
      continuity: 'retired',
      definition: { value: null }
    })
  })

  it('refuses before sending when the pairing now names another machine', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    await flush()
    h.setContinuity({ status: 'retired' })
    const change = vi.fn(async () => automation())
    await expect(h.controller.mutate(change, (next) => next)).rejects.toBeInstanceOf(
      AutomationOwnerChangedError
    )
    expect(change).not.toHaveBeenCalled()
    // What was read from the old machine is dropped.
    expect(h.controller.getSnapshot().definition.value).toBeNull()
    expect(h.controller.getSnapshot().continuity).toBe('retired')
  })

  it('re-keys to a same-machine re-pair and keeps the data', async () => {
    const h = harness()
    h.controller.start()
    h.shows[0].resolve(automation())
    await flush()
    const rekeyed: AutomationOwnerRef = {
      ...OWNER,
      authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 2 }
    }
    h.setContinuity({ status: 'continued', owner: rekeyed })
    const change = vi.fn(async (owner: AutomationOwnerRef) => {
      expect(owner).toEqual(rekeyed)
      return automation()
    })
    await h.controller.mutate(change, (next) => next)
    expect(change).toHaveBeenCalled()
  })

  it('freezes actions while a re-pair is still being checked, and resumes when it resolves', async () => {
    const h = harness()
    h.controller.start()
    h.setContinuity({ status: 'checking' })
    expect(h.controller.recheckOwner()).toBe('checking')
    await expect(h.controller.act(async () => 1)).rejects.toBeInstanceOf(
      AutomationOwnerChangedError
    )
    h.setContinuity({ status: 'same', owner: OWNER })
    expect(h.controller.recheckOwner()).toBe('same')
    await expect(h.controller.act(async () => 1)).resolves.toBe(1)
  })
})

describe('AutomationDetailsController selected run', () => {
  it('reads a run outside the newest rows by id and pins it', async () => {
    const older = run('old', 1)
    const h = harness({ readRun: vi.fn(async () => ({ kind: 'run' as const, run: older })) }, 'old')
    h.controller.start()
    h.pages[0].resolve({ runs: [run('r1', 10)], nextCursor: 'c1' })
    await flush()
    expect(h.deps.readRun).toHaveBeenCalledWith(OWNER, 'a1', 'old')
    expect(h.controller.getSnapshot().selected).toMatchObject({ status: 'ready', run: older })
  })

  it('uses the row when the run is among the newest', async () => {
    const h = harness({}, 'r1')
    h.controller.start()
    h.pages[0].resolve({ runs: [run('r1', 10)], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().selected?.status).toBe('in-window')
    expect(h.deps.readRun).not.toHaveBeenCalled()
  })

  it('keeps reading an older run when the independent definition arrives later', async () => {
    const requestedRun = deferred<AutomationRunRead>()
    const h = harness({ readRun: () => requestedRun.promise }, 'older')
    h.controller.start()
    h.pages[0].resolve({ runs: [], nextCursor: null })
    await flush()
    h.shows[0].resolve(automation())
    await flush()
    expect(h.controller.getSnapshot().selected?.status).toBe('loading')
    requestedRun.resolve({ kind: 'run', run: run('older', 1) })
    await flush()
    expect(h.controller.getSnapshot().selected).toMatchObject({ status: 'ready', runId: 'older' })
  })

  it('says a run is no longer kept without touching the definition', async () => {
    const h = harness({}, 'gone')
    h.controller.start()
    h.shows[0].resolve(automation())
    h.pages[0].resolve({ runs: [], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().selected?.status).toBe('run-missing')
    expect(h.controller.getSnapshot().definition.status).toBe('ready')
  })

  it('settles a "definition missing" run read with one definition read', async () => {
    const h = harness(
      { readRun: vi.fn(async () => ({ kind: 'definition-missing' as const })) },
      'x'
    )
    h.controller.start()
    h.shows[0].resolve(automation())
    h.pages[0].resolve({ runs: [], nextCursor: null })
    await flush()
    h.shows[1].resolve(automation())
    await flush()
    // The automation is there, so the run read failed; it never stays loading.
    expect(h.controller.getSnapshot().selected?.status).toBe('error')
    expect(h.controller.getSnapshot().definition.status).toBe('ready')
  })

  it('says an old host that ignored the run id can’t open it here', async () => {
    const h = harness({ readRun: vi.fn(async () => ({ kind: 'unsupported' as const })) }, 'x')
    h.controller.start()
    h.pages[0].resolve({ runs: [], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().selected?.status).toBe('unsupported')
  })
})

describe('AutomationDetailsController paging', () => {
  it('does not use an acknowledgement as proof that a refreshed page reaches retained history', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: [100, 99, 98, 97, 96].map((id) => run(String(id), id)),
      nextCursor: 'after-96'
    })
    await flush()
    h.controller.loadMore()
    h.pages[1].resolve({ runs: [run('95', 95)], nextCursor: 'after-95' })
    await flush()
    await h.controller.startRun(async () => ({ ...run('200', 200), status: 'dispatched' }))
    h.pages[2].resolve({
      runs: [200, 199, 198, 197, 196].map((id) => run(String(id), id)),
      nextCursor: 'after-196'
    })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
      '200',
      '199',
      '198',
      '197',
      '196'
    ])
    expect(h.controller.getSnapshot().runs.nextCursor).toBe('after-196')
  })

  it('settles an oversized exact lookup instead of retaining its completed loading state', async () => {
    const h = harness(
      {
        readRun: async () => ({
          kind: 'run',
          run: {
            ...run('oversized', 1),
            outputSnapshot: {
              format: 'plain_text',
              content: 'x'.repeat(20 * 1024 * 1024),
              capturedAt: 1,
              truncated: false
            }
          }
        })
      },
      'oversized'
    )
    h.controller.start()
    h.pages[0].resolve({ runs: [run('recent', 2)], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().selected).toEqual({
      runId: 'oversized',
      status: 'error',
      run: null,
      error: { kind: 'failed', message: 'Open in Automations to read more details.' }
    })
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual(['recent'])
  })

  it('rebases an unexpanded window before accepting an older page from its old cursor', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: [10, 9, 8, 7, 6].map((id) => run(String(id), id)),
      nextCursor: 'after-6'
    })
    await flush()
    h.controller.loadMore()
    h.controller.reload()
    h.pages[2].resolve({
      runs: [11, 10, 9, 8, 7].map((id) => run(String(id), id)),
      nextCursor: 'after-7'
    })
    await flush()
    h.pages[1].resolve({ runs: [run('5', 5)], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
      '11',
      '10',
      '9',
      '8',
      '7'
    ])
    expect(h.controller.getSnapshot().runs).toMatchObject({
      nextCursor: 'after-7',
      loadingMore: false
    })
    h.controller.loadMore()
    h.pages[3].resolve({ runs: [run('6', 6)], nextCursor: 'after-6' })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
      '11',
      '10',
      '9',
      '8',
      '7',
      '6'
    ])
  })

  it('rebases exhausted history on a disjoint refresh and retains a byte-short overlapping page', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: [10, 9, 8, 7, 6].map((id) => run(String(id), id)),
      nextCursor: 'after-6'
    })
    await flush()
    h.controller.loadMore()
    h.pages[1].resolve({ runs: [5, 4, 3, 2, 1].map((id) => run(String(id), id)), nextCursor: null })
    await flush()
    h.controller.reload()
    h.pages[2].resolve({
      runs: [16, 15, 14, 13, 12].map((id) => run(String(id), id)),
      nextCursor: 'after-12'
    })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
      '16',
      '15',
      '14',
      '13',
      '12'
    ])
    expect(h.controller.getSnapshot().runs.nextCursor).toBe('after-12')
    h.controller.loadMore()
    h.pages[3].resolve({ runs: [run('11', 11)], nextCursor: 'after-11' })
    await flush()
    h.controller.reload()
    h.pages[4].resolve({ runs: [run('17', 17), run('16', 16)], nextCursor: 'after-16' })
    await flush()
    expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
      '17',
      '16',
      '15',
      '14',
      '13',
      '12',
      '11'
    ])
    expect(h.controller.getSnapshot().runs.nextCursor).toBe('after-11')
  })

  it('settles an acknowledged run from an older page without duplicating it', async () => {
    const h = harness()
    await h.controller.startRun(async () => ({ ...run('ack', 6), status: 'dispatched' }))
    h.pages[0].resolve({
      runs: [11, 10, 9, 8, 7].map((id) => run(String(id), id)),
      nextCursor: 'after-7'
    })
    await flush()
    h.controller.loadMore()
    h.pages[1].resolve({ runs: [{ ...run('ack', 6), status: 'completed' }], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().acknowledgedRun).toBeNull()
    expect(h.controller.getSnapshot().runs.value.map((run) => [run.id, run.status])).toEqual([
      ['11', 'completed'],
      ['10', 'completed'],
      ['9', 'completed'],
      ['8', 'completed'],
      ['7', 'completed'],
      ['ack', 'completed']
    ])
  })

  it('invalidates reads across disposal and releases a settled mutation before restarting', async () => {
    const h = harness()
    h.controller.start()
    const change = deferred<Automation>()
    const saving = h.controller.mutate(
      () => change.promise,
      (next) => next
    )
    h.controller.dispose()
    change.resolve(automation({ enabled: false }))
    await saving
    h.controller.start()
    h.shows[0].resolve(automation({ name: 'obsolete' }))
    h.pages[0].resolve({ runs: [run('obsolete', 1)], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot().definition.value).toBeNull()
    expect(h.controller.getSnapshot().runs.value).toEqual([])
    await expect(
      h.controller.mutate(
        async () => automation(),
        (next) => next
      )
    ).resolves.toMatchObject({ id: 'a1' })
  })

  it('drops an older page that arrives after its owner is retired', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({ runs: [run('newest', 10)], nextCursor: 'older' })
    await flush()
    h.controller.loadMore()
    h.setContinuity({ status: 'retired' })
    h.controller.recheckOwner()
    h.pages[1].resolve({ runs: [run('old-computer', 1)], nextCursor: null })
    await flush()
    expect(h.controller.getSnapshot()).toMatchObject({
      continuity: 'retired',
      runs: { value: [] }
    })
  })

  it('pages older runs in and stops at the cap', async () => {
    const h = harness()
    h.controller.start()
    h.pages[0].resolve({
      runs: Array.from({ length: 5 }, (_, i) => run(`n${i}`, 1000 - i)),
      nextCursor: 'c'
    })
    await flush()
    for (let page = 0; page < 20 && !h.controller.getSnapshot().runs.capped; page += 1) {
      h.controller.loadMore()
      h.pages.at(-1)?.resolve({
        runs: Array.from({ length: 10 }, (_, i) => run(`p${page}-${i}`, 900 - page * 10 - i)),
        nextCursor: 'c'
      })
      await flush()
    }
    const runs = h.controller.getSnapshot().runs
    expect(runs.capped).toBe(true)
    expect(runs.value).toHaveLength(100)
  })
})

describe('automationActionOutcomeUnknown', () => {
  it('treats a refusal before sending as definite and a lost reply as unknown', () => {
    expect(automationActionOutcomeUnknown(new AutomationOwnerChangedError('retired'))).toBe(false)
    const hostError = Object.assign(new Error('Automation not found'), {
      name: 'RuntimeRpcCallError',
      code: 'not_found'
    })
    expect(automationActionOutcomeUnknown(hostError)).toBe(false)
    const timeout = Object.assign(new Error('timed out'), {
      name: 'RuntimeRpcCallError',
      code: 'request_timeout'
    })
    expect(automationActionOutcomeUnknown(timeout)).toBe(true)
    expect(automationActionOutcomeUnknown(new Error('socket closed'))).toBe(true)
  })
})
