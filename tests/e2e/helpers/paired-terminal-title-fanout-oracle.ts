import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../../src/shared/runtime-types'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { expect } from './orca-app'

const INITIAL_TITLE = '⠋ Cursor Agent'
const FINAL_TITLE = 'Cursor ready'

type TitleTarget = {
  tabId: string
  terminal: string
  worktreeId: string
}

type TitleTransportEvent = {
  decodedEnvelopeBytes: number
  snapshotVersion: number
  title: string
  worktreeId: string
}

type TitleStoreChange = {
  title: string
  worktreeId: string
}

type TitleProbeSample = {
  storeChanges: TitleStoreChange[]
  transportEvents: TitleTransportEvent[]
}

type BrowserTitleProbe = TitleProbeSample & {
  lastTitles: Record<string, string | null>
  responseCount: number
  subscription: null | { unsubscribe: () => void }
  unsubscribeStore: null | (() => void)
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

export async function verifyPairedTerminalTitleFanout(
  page: Page,
  targets: TitleTarget[]
): Promise<void> {
  const tokens = targets.map((_, index) => `TITLE_FANOUT_${index}_${Date.now()}`)
  await installTitleProbe(page, targets)
  try {
    await expect.poll(() => readProbeResponseCount(page), { timeout: 30_000 }).toBeGreaterThan(0)
    await resetTitleProbe(page, targets)

    await Promise.all(
      targets.map((target, index) =>
        sendFixtureCommand(page, target, `TITLE_START:${tokens[index]}`)
      )
    )
    await expectTitles(page, targets, INITIAL_TITLE)
    await expect
      .poll(async () => (await readTitleProbe(page)).transportEvents.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(targets.length)

    await Promise.all(
      targets.map((target, index) =>
        sendFixtureCommand(page, target, `TITLE_ANIMATE:${tokens[index]}`)
      )
    )
    await expectFixtureCompletion(page, targets, tokens)
    await expectTitles(page, targets, FINAL_TITLE)
    await expect
      .poll(async () => (await readTitleProbe(page)).transportEvents.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(targets.length * 2)

    const sample = await readTitleProbe(page)
    expectTitleFanoutSample(sample, targets)
  } finally {
    await disposeTitleProbe(page)
  }
}

async function installTitleProbe(page: Page, targets: TitleTarget[]): Promise<void> {
  await page.evaluate(
    async ({ targets, capability }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store is unavailable')
      }
      const environmentId = Array.from(
        store.getState().runtimeStatusByEnvironmentId.entries()
      ).find(([, entry]) => entry.status?.capabilities?.includes(capability))?.[0]
      if (!environmentId) {
        throw new Error('Paired runtime environment is unavailable')
      }
      const titleFor = (
        state: ReturnType<typeof store.getState>,
        target: (typeof targets)[number]
      ) =>
        state.tabsByWorktree[target.worktreeId]?.find((tab) => tab.id === target.tabId)?.title ??
        null
      const probe = {
        responseCount: 0,
        storeChanges: [] as TitleStoreChange[],
        transportEvents: [] as TitleTransportEvent[],
        lastTitles: Object.fromEntries(
          targets.map((target) => [target.worktreeId, titleFor(store.getState(), target)])
        ),
        subscription: null as null | { unsubscribe: () => void },
        unsubscribeStore: null as null | (() => void)
      }
      probe.unsubscribeStore = store.subscribe((state) => {
        for (const target of targets) {
          const title = titleFor(state, target)
          if (title === null || title === probe.lastTitles[target.worktreeId]) {
            continue
          }
          probe.lastTitles[target.worktreeId] = title
          probe.storeChanges.push({ worktreeId: target.worktreeId, title })
        }
      })
      probe.subscription = await window.api.runtimeEnvironments.subscribe(
        { selector: environmentId, method: 'session.tabs.subscribeAll', params: {} },
        {
          onResponse: (response) => {
            probe.responseCount += 1
            if (!response.ok) {
              return
            }
            const result = response.result as {
              type?: string
              worktree?: string
              snapshotVersion?: number
              tabs?: { type?: string; title?: string }[]
              snapshots?: {
                worktree?: string
                snapshotVersion?: number
                tabs?: { type?: string; title?: string }[]
              }[]
            }
            const snapshots = result.type === 'snapshots' ? (result.snapshots ?? []) : [result]
            const decodedEnvelopeBytes = new TextEncoder().encode(
              JSON.stringify(response)
            ).byteLength
            for (const snapshot of snapshots) {
              if (!targets.some((target) => target.worktreeId === snapshot.worktree)) {
                continue
              }
              const title = snapshot.tabs?.find((tab) => tab.type === 'terminal')?.title
              if (
                typeof snapshot.worktree === 'string' &&
                typeof snapshot.snapshotVersion === 'number' &&
                typeof title === 'string'
              ) {
                probe.transportEvents.push({
                  worktreeId: snapshot.worktree,
                  snapshotVersion: snapshot.snapshotVersion,
                  title,
                  decodedEnvelopeBytes
                })
              }
            }
          }
        }
      )
      Object.assign(globalThis, { __pairedTitleFanoutProbe: probe })
    },
    { targets, capability: TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY }
  )
}

async function resetTitleProbe(page: Page, targets: TitleTarget[]): Promise<void> {
  await page.evaluate((targets) => {
    const probe = (
      globalThis as typeof globalThis & { __pairedTitleFanoutProbe?: BrowserTitleProbe }
    ).__pairedTitleFanoutProbe
    if (!probe) {
      throw new Error('Paired title fanout probe is unavailable')
    }
    probe.transportEvents.length = 0
    probe.storeChanges.length = 0
    const state = window.__store?.getState()
    for (const target of targets) {
      probe.lastTitles[target.worktreeId] =
        state?.tabsByWorktree[target.worktreeId]?.find((tab) => tab.id === target.tabId)?.title ??
        null
    }
  }, targets)
}

async function readProbeResponseCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & { __pairedTitleFanoutProbe?: BrowserTitleProbe }
    ).__pairedTitleFanoutProbe
    if (!probe) {
      throw new Error('Paired title fanout probe is unavailable')
    }
    return probe.responseCount
  })
}

async function readTitleProbe(page: Page): Promise<TitleProbeSample> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & { __pairedTitleFanoutProbe?: BrowserTitleProbe }
    ).__pairedTitleFanoutProbe
    if (!probe) {
      throw new Error('Paired title fanout probe is unavailable')
    }
    return {
      storeChanges: [...probe.storeChanges],
      transportEvents: [...probe.transportEvents]
    }
  })
}

async function disposeTitleProbe(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & { __pairedTitleFanoutProbe?: BrowserTitleProbe }
      ).__pairedTitleFanoutProbe
      if (!probe) {
        return
      }
      probe.subscription?.unsubscribe()
      probe.unsubscribeStore?.()
      delete (globalThis as typeof globalThis & { __pairedTitleFanoutProbe?: unknown })
        .__pairedTitleFanoutProbe
    })
    .catch(() => undefined)
}

async function sendFixtureCommand(page: Page, target: TitleTarget, text: string): Promise<void> {
  await callRuntime(page, 'terminal.send', {
    terminal: target.terminal,
    text,
    enter: true,
    client: { id: 'paired-title-fanout-e2e', type: 'desktop' }
  })
}

async function expectFixtureCompletion(
  page: Page,
  targets: TitleTarget[],
  tokens: string[]
): Promise<void> {
  await expect
    .poll(
      async () =>
        Promise.all(
          targets.map(async (target, index) => {
            const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
              page,
              'terminal.read',
              { terminal: target.terminal, limit: 1_000 }
            )
            return result.terminal.tail.join('\n').includes(`TITLE_DONE:${tokens[index]}`)
          })
        ),
      { timeout: 30_000 }
    )
    .toEqual(Array(targets.length).fill(true))
}

async function expectTitles(page: Page, targets: TitleTarget[], expected: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ targets, expected }) =>
            targets.map(
              (target) =>
                window.__store
                  ?.getState()
                  .tabsByWorktree[target.worktreeId]?.find((tab) => tab.id === target.tabId)
                  ?.title === expected
            ),
          { targets, expected }
        ),
      { timeout: 30_000 }
    )
    .toEqual(Array(targets.length).fill(true))
}

function expectTitleFanoutSample(sample: TitleProbeSample, targets: TitleTarget[]): void {
  expect(sample.transportEvents).toHaveLength(targets.length * 2)
  expect(sample.storeChanges).toHaveLength(targets.length * 2)
  for (const target of targets) {
    const transport = sample.transportEvents.filter(
      (event) => event.worktreeId === target.worktreeId
    )
    expect(transport.map((event) => event.title)).toEqual([INITIAL_TITLE, FINAL_TITLE])
    expect(transport[1]?.snapshotVersion).toBeGreaterThan(transport[0]?.snapshotVersion ?? 0)
    expect(transport.every((event) => event.decodedEnvelopeBytes > 0)).toBe(true)
    expect(
      sample.storeChanges
        .filter((change) => change.worktreeId === target.worktreeId)
        .map((change) => change.title)
    ).toEqual([INITIAL_TITLE, FINAL_TITLE])
  }
}
