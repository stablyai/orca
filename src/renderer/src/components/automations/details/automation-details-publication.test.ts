import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AutomationRun,
  AutomationRunsPage
} from '../../../../../shared/automations/history/automation-run'
import type { AutomationRunRead } from '../hosts/automation-owner-reads'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import { AutomationDetailsController } from './automation-details-controller'

const owner = { authority: { kind: 'desktop' }, selector: { kind: 'self' } } as const
const live: AutomationDetailsController[] = []
afterEach(() => live.splice(0).forEach((controller) => controller.dispose()))
function held<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  await new Promise((done) => setTimeout(done, 0))
}
const run = (id: string, at = 1, status: AutomationRun['status'] = 'completed') =>
  makeRun({ id, automationId: 'a', title: id, scheduledFor: at, createdAt: at, status })
const page = (ids: string[], nextCursor: string | null): AutomationRunsPage => ({
  runs: ids.map((id) => run(id, Number(id))),
  nextCursor
})
function setup(selected: string | null = null) {
  const pages: ReturnType<typeof held<AutomationRunsPage>>[] = []
  const exact: ReturnType<typeof held<AutomationRunRead>>[] = []
  const listRunsPage = vi.fn(
    (
      _owner: AutomationOwnerRef,
      _automationId: string,
      _options: { limit: number; cursor?: string }
    ) => {
      const call = held<AutomationRunsPage>()
      pages.push(call)
      return call.promise
    }
  )
  const readRun = vi.fn(() => {
    const call = held<AutomationRunRead>()
    exact.push(call)
    return call.promise
  })
  const controller = new AutomationDetailsController(
    owner,
    'a',
    5,
    {
      showAutomation: async () => makeAutomation({ id: 'a' }),
      listRunsPage,
      readRun,
      evaluateOwner: () => ({ status: 'same', owner })
    },
    selected
  )
  live.push(controller)
  controller.start()
  return { controller, pages, exact, listRunsPage, readRun }
}
function large(id: string, chars: number): AutomationRun {
  return {
    ...run(id),
    outputSnapshot: {
      format: 'plain_text',
      content: 'x'.repeat(chars),
      capturedAt: 1,
      truncated: false
    }
  }
}

it('stages coverage and pagination with admission across two controllers sharing the real byte budget', async () => {
  const resident = setup()
  resident.pages[0].resolve({ runs: [large('resident', 10 * 1024 * 1024)], nextCursor: null })
  await flush()
  const h = setup()
  h.pages[0].resolve(page(['10', '9', '8', '7', '6'], 'after-6'))
  await flush()
  h.controller.loadMore()
  const oversized = { ...large('5', 3 * 1024 * 1024), scheduledFor: 5 }
  h.pages[1].resolve({ runs: [oversized], nextCursor: 'after-5' })
  await flush()
  expect(h.controller.getSnapshot().runs).toMatchObject({
    nextCursor: 'after-6',
    paged: false,
    coverageIds: ['10', '9', '8', '7', '6']
  })
  expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
    '10',
    '9',
    '8',
    '7',
    '6'
  ])
  resident.controller.dispose()
  h.controller.loadMore()
  h.pages[2].resolve({ runs: [oversized], nextCursor: 'after-5' })
  await flush()
  h.controller.reload()
  h.pages[3].resolve(page(['11', '10', '9', '8', '7'], 'after-7'))
  await flush()
  expect(h.controller.getSnapshot().runs.value.map((run) => run.id)).toEqual([
    '11',
    '10',
    '9',
    '8',
    '7',
    '6',
    '5'
  ])
  h.controller.loadMore()
  h.pages[4].resolve(page(['4'], 'after-4'))
  await flush()
  expect(h.listRunsPage.mock.calls.map((call) => call[2].cursor)).toEqual([
    undefined,
    'after-6',
    'after-6',
    undefined,
    'after-5'
  ])
})

it('refreshes the authority of a pinned running run independently of the first-page window', async () => {
  const h = setup('old')
  h.pages[0].resolve(page(['10'], null))
  await flush()
  h.exact[0].resolve({ kind: 'run', run: run('old', 1, 'dispatched') })
  await flush()
  expect(h.controller.getSnapshot().selected?.run?.status).toBe('dispatched')
  h.controller.reload()
  h.pages[1].resolve(page(['11'], null))
  await flush()
  expect(h.controller.getSnapshot().selected?.run?.status).toBe('dispatched')
  h.exact[1].resolve({ kind: 'run', run: run('old', 1, 'completed') })
  await flush()
  expect(h.controller.getSnapshot().selected?.run?.status).toBe('completed')
})

it.each(['error', 'run-missing'] as const)(
  'retains the sole terminal exact answer when a queued follow-up returns %s',
  async (outcome) => {
    const h = setup('old')
    h.pages[0].resolve(page(['10'], null))
    await flush()
    for (let index = 0; index < 20; index++) {
      h.controller.retrySelected()
    }
    await flush()
    expect(h.exact).toHaveLength(1)
    h.exact[0].resolve({ kind: 'run', run: { ...run('old'), chatSessionId: 'terminal-chat' } })
    await flush()
    expect(h.exact).toHaveLength(2)
    h.exact[1].resolve(
      outcome === 'error' ? { kind: 'error', error: new Error('offline') } : { kind: 'run-missing' }
    )
    await flush()
    expect(h.controller.getSnapshot().selected?.run).toMatchObject({
      id: 'old',
      status: 'completed',
      chatSessionId: 'terminal-chat'
    })
  }
)

it('keeps an admitted exact terminal and link when a held older page supplies its old snapshot', async () => {
  const h = setup('old')
  h.pages[0].resolve(page(['10'], 'after-10'))
  await flush()
  h.controller.loadMore()
  h.exact[0].resolve({ kind: 'run', run: { ...run('old'), chatSessionId: 'terminal-chat' } })
  await flush()
  h.pages[1].resolve({ runs: [run('old', 1, 'dispatched'), run('9', 9)], nextCursor: 'after-old' })
  await flush()
  const snapshot = h.controller.getSnapshot()
  expect(snapshot.runs.value.filter((row) => row.id === 'old')).toHaveLength(1)
  expect(snapshot.runs.value.find((row) => row.id === 'old')).toMatchObject({
    status: 'completed',
    chatSessionId: 'terminal-chat'
  })
  expect(snapshot.selected?.run?.chatSessionId).toBe('terminal-chat')
  expect(snapshot.runs.coverageIds).toEqual(['10', 'old', '9'])
  expect(snapshot.runs.nextCursor).toBe('after-old')
})

it('keeps a refused page remedy through an independent exact update until that acquisition is admitted', async () => {
  const resident = setup()
  resident.pages[0].resolve({ runs: [large('resident', 10 * 1024 * 1024)], nextCursor: null })
  await flush()
  const h = setup('old')
  const refused = { runs: [large('10', 3 * 1024 * 1024)], nextCursor: 'after-10' }
  h.pages[0].resolve(refused)
  await flush()
  expect(h.controller.getSnapshot().runs.capacityError?.source).toBe('newest')
  h.exact[0].resolve({ kind: 'run', run: run('old') })
  await flush()
  expect(h.controller.getSnapshot().selected?.run?.id).toBe('old')
  expect(h.controller.getSnapshot().runs.capacityError?.source).toBe('newest')
  expect(h.controller.getSnapshot().runs.nextCursor).toBeNull()
  resident.controller.dispose()
  h.controller.reload()
  h.pages[1].resolve(refused)
  await flush()
  expect(h.controller.getSnapshot().runs.capacityError).toBeNull()
  expect(h.controller.getSnapshot().runs.nextCursor).toBe('after-10')
})

it.each([true, false])(
  'keeps newest and older failures independent in either settle order (older first: %s)',
  async (olderFirst) => {
    const h = setup()
    h.pages[0].resolve(page(['10'], 'after-10'))
    await flush()
    h.controller.loadMore()
    h.controller.reload()
    if (olderFirst) {
      h.pages[1].reject(new Error('older failed'))
      await flush()
    }
    h.pages[2].reject(new Error('newest failed'))
    await flush()
    if (!olderFirst) {
      h.pages[1].reject(new Error('older failed'))
      await flush()
    }
    expect(h.controller.getSnapshot().runs).toMatchObject({
      error: { message: 'newest failed' },
      stale: true,
      olderError: { message: 'older failed' }
    })
    h.controller.loadMore()
    h.pages[3].resolve(page(['9'], null))
    await flush()
    expect(h.controller.getSnapshot().runs).toMatchObject({
      error: { message: 'newest failed' },
      stale: true,
      olderError: null
    })
  }
)

it.each([true, false])(
  'preserves an older failure when a newest success settles in either order (%s)',
  async (olderFirst) => {
    const h = setup()
    h.pages[0].resolve(page(['10'], 'after-10'))
    await flush()
    h.controller.loadMore()
    h.controller.reload()
    if (olderFirst) {
      h.pages[1].reject(new Error('older failed'))
      await flush()
    }
    h.pages[2].resolve(page(['10'], 'after-10'))
    await flush()
    if (!olderFirst) {
      h.pages[1].reject(new Error('older failed'))
      await flush()
    }
    expect(h.controller.getSnapshot().runs).toMatchObject({
      error: null,
      stale: false,
      olderError: { message: 'older failed' }
    })
  }
)
