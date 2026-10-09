/**
 * Measures command → drawn update for layout commands, idle and with another tab's terminal
 * flooding output (`yes`). Measuring only: it records p50/p95 per action in the oracle report and
 * never fails on a number, so a later budget can gate on it.
 *
 * The clock runs from just before the command is sent until the window's DOM shows the result,
 * polled every animation frame over CDP, so each sample includes one CDP round trip.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './helpers/terminal-restart-persistence'
import { splitActiveTerminalPane, waitForActiveTerminalManager } from './helpers/terminal'
import { closeActivePaneFromKeyboard, waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import { ORACLE_REPORT_DIR_ENV } from './helpers/workspace-layout-oracle-session'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

const SAMPLES = Number(process.env.ORCA_LAYOUT_ORACLE_LATENCY_SAMPLES ?? 10)

type Condition = 'idle' | 'flood'
type Samples = Record<string, number[]>

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

function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
}

async function timeUntil(
  page: Page,
  command: () => Promise<unknown>,
  drawn: (page: Page) => Promise<unknown>
): Promise<number> {
  const started = performance.now()
  await command()
  await drawn(page)
  return performance.now() - started
}

const paneCount = (page: Page, count: number) =>
  page.waitForFunction(
    (expected) => {
      const surface = Array.from(
        document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')
      ).find(
        (element) => element.getBoundingClientRect().width > 0 && element.querySelector('.pane')
      )
      return (surface?.querySelectorAll('.pane[data-leaf-id]').length ?? 0) === expected
    },
    count,
    { polling: 'raf', timeout: 30_000 }
  )

async function measureCondition(
  page: Page,
  client: RuntimeClient,
  worktreeId: string,
  condition: Condition,
  samples: Samples
): Promise<void> {
  const worktree = `id:${worktreeId}`
  const add = (action: string, ms: number): void => {
    ;(samples[`${action} (${condition})`] ??= []).push(ms)
  }
  for (let index = 0; index < SAMPLES; index += 1) {
    add(
      'split',
      await timeUntil(
        page,
        () => splitActiveTerminalPane(page, 'vertical'),
        (p) => paneCount(p, 2)
      )
    )
    await waitForBoundPanes(page, 2)
    add(
      'close pane',
      await timeUntil(
        page,
        () => closeActivePaneFromKeyboard(page, 2),
        (p) => paneCount(p, 1)
      )
    )

    const tabsBefore = await page.locator(SORTABLE_TAB).count()
    const strip = (count: number) => (p: Page) =>
      p.waitForFunction(
        ({ selector, expected }) => document.querySelectorAll(selector).length === expected,
        { selector: SORTABLE_TAB, expected: count },
        { polling: 'raf', timeout: 30_000 }
      )
    const handles = async (): Promise<RuntimeTerminalListResult['terminals']> =>
      (await read<RuntimeTerminalListResult>(client, 'terminal.list', { worktree })).terminals
    const existing = new Set((await handles()).map((terminal) => terminal.handle))
    add(
      'new tab',
      await timeUntil(
        page,
        () => client.call('terminal.create', { worktree }),
        strip(tabsBefore + 1)
      )
    )
    const created = (await handles()).find((terminal) => !existing.has(terminal.handle))!
    const title = `latency-${condition}-${index}`
    add(
      'rename',
      await timeUntil(
        page,
        () => client.call('terminal.rename', { terminal: created.handle, title }),
        (p) => p.locator(`${SORTABLE_TAB}[data-tab-title="${title}"]`).waitFor({ timeout: 30_000 })
      )
    )
    const tabs = await read<RuntimeMobileSessionTabsResult>(client, 'session.tabs.list', {
      worktree
    })
    const group = tabs.tabGroups![0]!
    const reversed = group.tabOrder.toReversed()
    add(
      'tab reorder',
      await timeUntil(
        page,
        () =>
          client.call('session.tabs.move', {
            worktree,
            tabId: reversed[0],
            targetGroupId: group.id,
            kind: 'reorder',
            tabOrder: reversed
          }),
        (p) =>
          p.waitForFunction(
            ({ selector, order }) =>
              Array.from(document.querySelectorAll<HTMLElement>(selector))
                .map((tab) => tab.dataset.tabId)
                .join(',') === order,
            { selector: SORTABLE_TAB, order: reversed.join(',') },
            { polling: 'raf', timeout: 30_000 }
          )
      )
    )
    add(
      'close tab',
      await timeUntil(
        page,
        () => client.call('terminal.close', { terminal: created.handle }),
        strip(tabsBefore)
      )
    )
    await waitForActiveTerminalManager(page)
  }
}

// oxlint-disable-next-line no-empty-pattern -- The measurement owns its launch.
test('layout oracle: command to drawn latency', async ({}, testInfo) => {
  test.setTimeout(15 * 60_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  const { app, page } = await session.launch()
  try {
    const samples: Samples = {}
    const { worktreeId } = await bootstrapFirstLaunch(page, repoPath)
    const worktree = `id:${worktreeId}`
    const client = new RuntimeClient(session.userDataDir, 30_000)
    await waitForBoundPanes(page, 1)
    await measureCondition(page, client, worktreeId, 'idle', samples)

    // A second tab floods output for the whole flood round; the measured tab stays active.
    const list = await read<RuntimeTerminalListResult>(client, 'terminal.list', { worktree })
    const measured = list.terminals[0]!
    await client.call('terminal.create', { worktree, command: 'yes orca-latency-flood' })
    await client.call('terminal.focus', { terminal: measured.handle, navigation: 'host' })
    await waitForActiveTerminalManager(page)
    await measureCondition(page, client, worktreeId, 'flood', samples)

    const summary = Object.fromEntries(
      Object.entries(samples).map(([action, values]) => [
        action,
        {
          n: values.length,
          p50: Math.round(percentile(values, 50)),
          p95: Math.round(percentile(values, 95))
        }
      ])
    )
    console.log(`[layout-oracle] latency ms\n${JSON.stringify(summary, null, 2)}`)
    const dir = process.env[ORACLE_REPORT_DIR_ENV] ?? testInfo.outputPath('layout-oracle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `latency-${Date.now()}.json`),
      `${JSON.stringify({ scenario: 'latency', summary, samples }, null, 2)}\n`
    )
  } finally {
    await session.close(app)
    await session.dispose()
  }
})
