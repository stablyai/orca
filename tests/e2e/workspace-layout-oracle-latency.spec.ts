/**
 * Measures command → drawn update for layout commands, idle, with three panes flooding output
 * (`yes`), one of them in a hidden worktree, and with the same three panes flooding terminal titles
 * instead (a new title per line, the worst case for live pane titles), and time to first drawn
 * after relaunching a large
 * profile. Measuring only: it records each number in the oracle report and never fails on one,
 * so a later budget can gate on it. The plain run has no layout subscriber, so main is measured as
 * users run it; the subscribed run holds one `layout.subscribe` stream open in the window, as the
 * layout client will. The committed main baseline is workspace-layout-oracle-latency-baseline.json.
 *
 * Each command is timed twice. The in-app clock (helpers/layout-latency-probe.ts) stops in the
 * window at React's commit and at the next frame. The outer clock stops when the test sees the
 * drawn result over CDP, so it also holds one DevTools round trip.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './helpers/terminal-restart-persistence'
import {
  focusActiveTerminalInput,
  splitActiveTerminalPane,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { resolveActiveTabId } from './helpers/terminal-pane-identity'
import { waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { ORACLE_REPORT_DIR_ENV } from './helpers/workspace-layout-oracle-session'
import {
  armLayoutLatencyProbe,
  readLayoutLatencyProbe,
  type ArmOptions,
  type DrawnCondition,
  type InAppSample
} from './helpers/layout-latency-probe'
import { installFirstDrawnWatch, readFirstDrawn } from './helpers/first-drawn-watch'
import {
  summarizeEventLoopDelay,
  waitForEventLoopDelayWindow,
  type EventLoopDelaySummary
} from './helpers/event-loop-delay-report'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeWorktreeCreateResult
} from '../../src/shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

// The baseline is taken with 100; routine runs keep 10, since a Linux CI sample waits ~1 s per frame.
const SAMPLES = Number(process.env.ORCA_LAYOUT_ORACLE_LATENCY_SAMPLES ?? 10)
const STARTUP_SAMPLES = Number(process.env.ORCA_LAYOUT_ORACLE_STARTUP_SAMPLES ?? 10)
const FLOOD_COMMAND = 'yes orca-latency-flood'
// About 50 titles a second, each different, so none is folded away as a spinner frame: a busy
// agent's title burst. The echo proves the loop runs.
const TITLE_FLOOD_COMMAND =
  'i=0; while :; do i=$((i+1)); printf "\\033]0;orca-title-flood %d\\007" $i; [ $((i % 50)) = 0 ] && echo orca-latency-flood; sleep 0.02; done'
const CLOSE_CONFIRM = 'Stop and Close'
const LARGE_PROFILE = { hiddenWorktrees: 12, tabsPerWorktree: 3, activePanes: 4 }

type Condition = 'idle' | 'flood' | 'titles'
type Sample = { outerMs: number; inApp: InAppSample }
type Samples = Record<string, Sample[]>
/** Main's memory at a phase's start and end, in MB; no GC is forced, so read it as a trend. */
type MainMemory = { heapUsedMb: [number, number]; rssMb: [number, number] }
/** What the window's layout stream received during a phase. */
type StreamTraffic = { frames: number; kb: number; seconds: number }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __layoutStreamTraffic?: { frames: number; bytes: number; errors: number }
  }
}

async function readMainMemory(
  app: ElectronApplication
): Promise<{ heapUsed: number; rss: number }> {
  return app.evaluate(() => {
    const { heapUsed, rss } = process.memoryUsage()
    return { heapUsed, rss }
  })
}

/** Holds one `layout.subscribe` stream open in the window for the rest of the run. */
async function attachLayoutSubscriber(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const traffic = { frames: 0, bytes: 0, errors: 0 }
    window.__layoutStreamTraffic = traffic
    await window.api.runtime.subscribe({ method: 'layout.subscribe', params: {} }, (response) => {
      if (!response.ok) {
        traffic.errors += 1
        return
      }
      traffic.frames += 1
      traffic.bytes += JSON.stringify(response.result).length
    })
  })
  await expect
    .poll(() => page.evaluate(() => window.__layoutStreamTraffic?.frames ?? 0))
    .toBeGreaterThan(0)
}

async function readStreamTraffic(page: Page): Promise<{ frames: number; bytes: number }> {
  const traffic = await page.evaluate(() => window.__layoutStreamTraffic ?? null)
  if (traffic && traffic.errors > 0) {
    throw new Error(`layout stream reported ${traffic.errors} error frame(s)`)
  }
  return { frames: traffic?.frames ?? 0, bytes: traffic?.bytes ?? 0 }
}

/** Reads can briefly fail while the window re-publishes its terminals; only reads are retried. */
async function read<T>(client: RuntimeClient, method: string, params: unknown): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return (await client.call<T>(method, params)).result
    } catch (error) {
      if (Date.now() > deadline || !String(error).includes('unavailable')) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

function stats(values: number[]): { p50: number; p95: number; max: number } {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
  return {
    p50: Math.round(at(50)),
    p95: Math.round(at(95)),
    max: Math.round(sorted.at(-1) ?? Number.NaN)
  }
}

/** Times one command on both clocks; null when it stopped on a confirmation. */
async function timeCommand(
  page: Page,
  condition: DrawnCondition,
  options: ArmOptions,
  send: () => Promise<unknown>
): Promise<Sample | null> {
  await armLayoutLatencyProbe(page, condition, options)
  const sentAt = Date.now()
  await send()
  const inApp = await readLayoutLatencyProbe(page, sentAt)
  return inApp ? { outerMs: Date.now() - sentAt, inApp } : null
}

/** The split helper's call, stamped in the window right before it runs. */
async function stampedSplit(page: Page): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  await page.evaluate((tabId) => {
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!manager?.splitPane || !pane || !window.__layoutLatencyProbe) {
      throw new Error('stampedSplit: active pane manager or probe not ready')
    }
    window.__layoutLatencyProbe.startedAt = Date.now()
    manager.splitPane(pane.id, 'vertical')
  }, tabId)
}

async function measureCondition(
  page: Page,
  client: RuntimeClient,
  worktreeId: string,
  condition: Condition,
  samples: Samples
): Promise<number> {
  const worktree = `id:${worktreeId}`
  const add = (action: string, sample: Sample | null): void => {
    if (!sample) {
      throw new Error(`${action} asked for confirmation`)
    }
    ;(samples[`${action} (${condition})`] ??= []).push(sample)
  }
  const sender: ArmOptions = { startOn: 'sender' }
  let confirms = 0
  for (let index = 0; index < SAMPLES; index += 1) {
    add(
      'split',
      await timeCommand(page, { kind: 'panes', count: 2 }, sender, () => stampedSplit(page))
    )
    await waitForBoundPanes(page, 2)
    // A fresh shell can still read as busy and ask first; retry so close pane gets SAMPLES too.
    for (;;) {
      await focusActiveTerminalInput(page)
      const closed = await timeCommand(
        page,
        { kind: 'panes', count: 1 },
        { startOn: 'keydown', confirmButton: CLOSE_CONFIRM },
        () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
      )
      if (closed) {
        add('close pane', closed)
        break
      }
      confirms += 1
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
    }

    const tabsBefore = await page.locator(SORTABLE_TAB).count()
    const handles = async (): Promise<RuntimeTerminalListResult['terminals']> =>
      (await read<RuntimeTerminalListResult>(client, 'terminal.list', { worktree })).terminals
    const existing = new Set((await handles()).map((terminal) => terminal.handle))
    add(
      'new tab',
      await timeCommand(page, { kind: 'tabs', count: tabsBefore + 1 }, sender, () =>
        client.call('terminal.create', { worktree })
      )
    )
    const created = (await handles()).find((terminal) => !existing.has(terminal.handle))!
    const title = `latency-${condition}-${index}`
    add(
      'rename',
      await timeCommand(page, { kind: 'tabTitle', title }, sender, () =>
        client.call('terminal.rename', { terminal: created.handle, title })
      )
    )
    const tabs = await read<RuntimeMobileSessionTabsResult>(client, 'session.tabs.list', {
      worktree
    })
    const group = tabs.tabGroups![0]!
    const reversed = group.tabOrder.toReversed()
    add(
      'tab reorder',
      await timeCommand(page, { kind: 'tabOrder', order: reversed.join(',') }, sender, () =>
        client.call('session.tabs.move', {
          worktree,
          tabId: reversed[0],
          targetGroupId: group.id,
          kind: 'reorder',
          tabOrder: reversed
        })
      )
    )
    add(
      'close tab',
      await timeCommand(page, { kind: 'tabs', count: tabsBefore }, sender, () =>
        client.call('terminal.close', { terminal: created.handle })
      )
    )
    await waitForActiveTerminalManager(page)
  }
  return confirms
}

/** The flood condition is only real if every flooding pane is producing output. */
async function expectFlooding(client: RuntimeClient, handle: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
          terminal: handle,
          limit: 20
        })
        return read.result.terminal.tail.join('\n')
      },
      { timeout: 30_000, message: `flooding terminal ${handle} never produced output` }
    )
    .toContain('orca-latency-flood')
}

/** A worktree of the seeded repo that is never activated, removed by the returned cleanup. */
async function createHiddenWorktree(
  client: RuntimeClient,
  worktreeId: string,
  name: string
): Promise<{ id: string; remove: () => Promise<void> }> {
  const shown = await client.call<{ worktree: { repoId: string } }>('worktree.show', {
    worktree: `id:${worktreeId}`
  })
  const created = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
    repo: `id:${shown.result.worktree.repoId}`,
    name: `${name}-${Date.now()}`,
    noParent: true,
    activate: false,
    setupDecision: 'skip'
  })
  const id = created.result.worktree.id
  return {
    id,
    remove: async () => {
      await client.call('worktree.rm', { worktree: `id:${id}`, force: true, runHooks: false })
    }
  }
}

type Stats = ReturnType<typeof stats>
type StartupSample = { firstDrawnMs: number; eventLoopDelayMax: number }
type LatencyReport =
  | {
      scenario: 'latency' | 'latency-subscribed'
      summary: Record<string, { n: number; inAppCommit: Stats; inAppDrawn: Stats; outer: Stats }>
      eventLoopDelay: Record<string, EventLoopDelaySummary>
      mainMemory: Record<Condition, MainMemory>
      streamTraffic?: Record<Condition, StreamTraffic>
      closeConfirms: Record<Condition, number>
      samples: Samples
    }
  | {
      scenario: 'first-drawn'
      note: string
      profile: typeof LARGE_PROFILE
      firstDrawn: Stats & { n: number }
      eventLoopDelayMax: Stats
      samples: StartupSample[]
    }

/** All but the samples go to the log on one line, so a CI run's numbers can be read from it. */
function writeLatencyReport(testInfo: TestInfo, { samples, ...summary }: LatencyReport): void {
  const report = { ...summary, platform: process.platform }
  console.log(`[layout-oracle] ${JSON.stringify(report)}`)
  const scenario = summary.scenario
  const dir = process.env[ORACLE_REPORT_DIR_ENV] ?? testInfo.outputPath('layout-oracle')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `${scenario}-${Date.now()}.json`),
    `${JSON.stringify({ ...report, samples }, null, 2)}\n`
  )
}

async function measureLatency(testInfo: TestInfo, subscribed: boolean): Promise<void> {
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  const { app, page } = await session.launch()
  const cleanups: (() => Promise<void>)[] = []
  try {
    const samples: Samples = {}
    const { worktreeId } = await bootstrapFirstLaunch(page, repoPath)
    const worktree = `id:${worktreeId}`
    const client = new RuntimeClient(session.userDataDir, 30_000)
    await waitForBoundPanes(page, 1)
    if (subscribed) {
      await attachLayoutSubscriber(page)
    }
    type Mark = { at: number; heapUsed: number; rss: number; frames: number; bytes: number }
    const mark = async (): Promise<Mark> => ({
      at: Date.now(),
      ...(await readMainMemory(app)),
      ...(await readStreamTraffic(page))
    })
    type Phase = { from: Mark; to: Mark; confirms: number }
    const measurePhase = async (condition: Condition): Promise<Phase> => {
      const from = await mark()
      const confirms = await measureCondition(page, client, worktreeId, condition, samples)
      return { from, to: await mark(), confirms }
    }
    const idle = await measurePhase('idle')

    // Two flooding tabs beside the measured one and one in a worktree that is never shown.
    const list = await read<RuntimeTerminalListResult>(client, 'terminal.list', { worktree })
    const measured = list.terminals[0]!
    const hidden = await createHiddenWorktree(client, worktreeId, 'latency-flood')
    cleanups.push(hidden.remove)
    const startFloods = async (command: string): Promise<string[]> => {
      const handles: string[] = []
      for (const target of [worktree, worktree, `id:${hidden.id}`]) {
        const flood = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: target,
          command
        })
        await expectFlooding(client, flood.result.terminal.handle)
        handles.push(flood.result.terminal.handle)
      }
      await client.call('terminal.focus', { terminal: measured.handle, navigation: 'host' })
      await waitForActiveTerminalManager(page)
      return handles
    }
    const floods = await startFloods(FLOOD_COMMAND)
    const flood = await measurePhase('flood')
    for (const handle of floods) {
      await client.call('terminal.close', { terminal: handle })
    }
    await startFloods(TITLE_FLOOD_COMMAND)
    const titles = await measurePhase('titles')

    const summary = Object.fromEntries(
      Object.entries(samples).map(([action, values]) => [
        action,
        {
          n: values.length,
          inAppCommit: stats(values.map((sample) => sample.inApp.commitMs)),
          inAppDrawn: stats(values.map((sample) => sample.inApp.drawnMs)),
          outer: stats(values.map((sample) => sample.outerMs))
        }
      ])
    )
    const perCondition = <T>(read: (phase: Phase) => T): Record<Condition, T> => ({
      idle: read(idle),
      flood: read(flood),
      titles: read(titles)
    })
    const mb = (bytes: number): number => Math.round(bytes / 1024 / 102.4) / 10
    writeLatencyReport(testInfo, {
      scenario: subscribed ? 'latency-subscribed' : 'latency',
      summary,
      eventLoopDelay: perCondition(({ from, to }) =>
        summarizeEventLoopDelay(session.userDataDir, 'main', from.at, to.at)
      ),
      mainMemory: perCondition(({ from, to }) => ({
        heapUsedMb: [mb(from.heapUsed), mb(to.heapUsed)],
        rssMb: [mb(from.rss), mb(to.rss)]
      })),
      ...(subscribed
        ? {
            streamTraffic: perCondition(({ from, to }) => ({
              frames: to.frames - from.frames,
              kb: Math.round((to.bytes - from.bytes) / 1024),
              seconds: Math.round((to.at - from.at) / 1000)
            }))
          }
        : {}),
      closeConfirms: perCondition(({ confirms }) => confirms),
      samples
    })
  } finally {
    for (const cleanup of cleanups) {
      await cleanup().catch((error: unknown) => console.warn('[layout-oracle] cleanup', error))
    }
    await session.close(app)
    await session.dispose()
  }
}

// oxlint-disable-next-line no-empty-pattern -- The measurement owns its launch.
test('layout oracle: command to drawn latency', async ({}, testInfo) => {
  test.setTimeout(90 * 60_000)
  await measureLatency(testInfo, false)
})

// oxlint-disable-next-line no-empty-pattern -- The measurement owns its launch.
test('layout oracle: command to drawn latency with a layout subscriber', async ({}, testInfo) => {
  test.setTimeout(90 * 60_000)
  await measureLatency(testInfo, true)
})

// oxlint-disable-next-line no-empty-pattern -- The measurement owns its launches.
test('layout oracle: time to first drawn on a large profile', async ({}, testInfo) => {
  test.setTimeout(30 * 60_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  let { app, page } = await session.launch()
  const cleanups: (() => Promise<void>)[] = []
  try {
    const { worktreeId } = await bootstrapFirstLaunch(page, repoPath)
    const worktree = `id:${worktreeId}`
    const client = new RuntimeClient(session.userDataDir, 30_000)
    for (let index = 0; index < LARGE_PROFILE.hiddenWorktrees; index += 1) {
      const hidden = await createHiddenWorktree(client, worktreeId, `latency-profile-${index}`)
      cleanups.push(hidden.remove)
      for (let tab = 0; tab < LARGE_PROFILE.tabsPerWorktree; tab += 1) {
        await client.call('terminal.create', { worktree: `id:${hidden.id}` })
      }
    }
    for (let tab = 1; tab < LARGE_PROFILE.tabsPerWorktree; tab += 1) {
      await client.call('terminal.create', { worktree })
    }
    const list = await read<RuntimeTerminalListResult>(client, 'terminal.list', { worktree })
    await client.call('terminal.focus', { terminal: list.terminals[0]!.handle, navigation: 'host' })
    await waitForActiveTerminalManager(page)
    for (let panes = 2; panes <= LARGE_PROFILE.activePanes; panes += 1) {
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, panes)
    }

    const startup: StartupSample[] = []
    for (let index = 0; index < STARTUP_SAMPLES; index += 1) {
      await session.close(app)
      ;({ app, page } = await session.launch({
        beforeFirstWindow: (next) => installFirstDrawnWatch(next, LARGE_PROFILE.activePanes)
      }))
      const { processStartedAt, drawnAt } = await readFirstDrawn(app, page)
      await waitForEventLoopDelayWindow(session.userDataDir, drawnAt)
      startup.push({
        firstDrawnMs: Math.round(drawnAt - processStartedAt),
        eventLoopDelayMax: summarizeEventLoopDelay(
          session.userDataDir,
          'main',
          processStartedAt,
          drawnAt
        ).max
      })
    }
    writeLatencyReport(testInfo, {
      scenario: 'first-drawn',
      note: 'from main process start, so includes DevTools attach; warm PTY daemon; relative use only',
      profile: LARGE_PROFILE,
      firstDrawn: { n: startup.length, ...stats(startup.map((sample) => sample.firstDrawnMs)) },
      eventLoopDelayMax: stats(startup.map((sample) => sample.eventLoopDelayMax)),
      samples: startup
    })
  } finally {
    for (const cleanup of cleanups) {
      await cleanup().catch((error: unknown) => console.warn('[layout-oracle] cleanup', error))
    }
    await session.close(app)
    await session.dispose()
  }
})
