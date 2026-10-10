/**
 * Layout oracle scenarios on a headless `orca serve` (orcad and Electron serve), driven only through
 * runtime RPC from paired clients and the local CLI. After every step the runtime's layout (its
 * saved session) is checked against the structural rules, what each client is told, the expected
 * panes per tab and, across restarts, the layout from before. #12723 needs SSH and is not covered.
 *
 * `ORCA_LAYOUT_ORACLE_RECORD=1` records without failing; `ORCA_LAYOUT_ORACLE_REPEAT=<n>` repeats;
 * `ORCA_LAYOUT_ORACLE_HEADLESS_HOSTS=orcad,electron` picks the hosts (both by default).
 *
 * Run:
 *   ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm exec playwright test \
 *     tests/e2e/workspace-layout-oracle-headless.spec.ts --config tests/playwright.config.ts \
 *     --project electron-headless --workers=1
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalSplit
} from '../../src/shared/runtime-terminal-contracts'
import { expect, test } from './helpers/orca-app'
import {
  addRepoWorktree,
  cliClient,
  orcadNodeExecutable,
  pairedClient,
  readHeadlessPartitions,
  startHeadlessOracleHost,
  type HeadlessHostKind,
  type HeadlessOracleHost
} from './helpers/headless-layout-oracle-hosts'
import { LayoutOracle, type OracleFinding } from './helpers/workspace-layout-oracle'
import type { OracleLayout } from './helpers/workspace-layout-oracle-model'
import { ORACLE_REPORT_DIR_ENV } from './helpers/workspace-layout-oracle-session'
import { unexpectedFindings } from './workspace-layout-oracle-known-on-main'

type Run = {
  host: HeadlessOracleHost
  worktreeId: string
  worktree: string
  /** Two paired clients and the local CLI. */
  a: RuntimeClient
  b: RuntimeClient
  cli: RuntimeClient
  oracle: LayoutOracle
  /** Settles and checks the layout once per view (paired client A, then the CLI by default). */
  check: (
    label: string,
    panesPerTab: number[],
    views?: View[],
    removed?: number
  ) => Promise<OracleLayout>
  /** Checks, restarts serve (cold: PTY daemon killed too), checks, and diffs against before. */
  restart: (label: string, panesPerTab: number[], cold?: boolean) => Promise<void>
  /** Records an 'expected' finding when `details` is non-empty. */
  expectNone: (step: string, details: string[]) => void
}

type View = { name: string; client: RuntimeClient }
type Scenario = { id: string; journey: (run: Run) => Promise<void> }

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Runs a command; a failure becomes an 'expected' finding instead of ending the scenario. */
async function attempt<T>(run: Run, step: string, command: () => Promise<T>): Promise<T | null> {
  try {
    return await command()
  } catch (error) {
    run.expectNone(step, [`command failed: ${errorText(error)}`])
    return null
  }
}

async function listTerminals(client: RuntimeClient, worktree: string) {
  const listed = await client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
  return listed.result.terminals
}

async function handleForTab(run: Run, tabId: string): Promise<string> {
  let handle: string | undefined
  await expect
    .poll(
      async () => {
        const terminals = await listTerminals(run.cli, run.worktree).catch(() => [])
        handle = terminals.find((terminal) => terminal.tabId === tabId)?.handle
        return handle
      },
      { timeout: 15_000, message: `no terminal handle for tab ${tabId}` }
    )
    .toBeDefined()
  return handle!
}

async function createTab(run: Run, client: RuntimeClient): Promise<string> {
  const created = await client.call<{ tab: { parentTabId: string } }>(
    'session.tabs.createTerminal',
    { worktree: run.worktree }
  )
  return created.result.tab.parentTabId
}

async function createTerminal(run: Run): Promise<RuntimeTerminalCreate> {
  const created = await run.a.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: run.worktree
  })
  return created.result.terminal
}

/** Every view's listed title for one tab; the client check only compares titles the runtime saved. */
async function titlesOf(run: Run, tabId: string, views: View[]): Promise<string[]> {
  const titles: string[] = []
  for (const { name, client } of views) {
    const tabs = await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: run.worktree
    })
    for (const tab of tabs.result.tabs) {
      if (tab.type === 'terminal' && tab.parentTabId === tabId) {
        titles.push(`${name} session.tabs.list "${tab.title}"`)
      }
    }
    for (const terminal of await listTerminals(client, run.worktree)) {
      if (terminal.tabId === tabId) {
        titles.push(`${name} terminal.list "${terminal.title}"`)
      }
    }
  }
  return titles
}

type GroupView = { id: string; activeTabId: string | null; tabOrder: string[] }

/** The groups paired client A is told about: order, membership and each group's selected tab. */
async function groupsOf(run: Run): Promise<GroupView[]> {
  const tabs = await run.a.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: run.worktree
  })
  return (tabs.result.tabGroups ?? []).map(({ id, activeTabId, tabOrder }) => ({
    id,
    activeTabId,
    tabOrder
  }))
}

/**
 * Moves a tab through the phone/CLI path, then checks the groups' tab orders and selection: the
 * moved tab is selected where it lands; any other group keeps its selection while that tab stays,
 * else falls back to its first tab.
 */
async function moveTab(
  run: Run,
  step: string,
  move: Record<string, unknown> & { tabId: string },
  expectedOrders: string[][]
): Promise<GroupView[]> {
  const before = await groupsOf(run)
  await attempt(run, step, () =>
    run.a.call('session.tabs.move', { worktree: run.worktree, ...move })
  )
  let after: GroupView[] = []
  await expect
    .poll(
      async () => {
        after = await groupsOf(run)
        return JSON.stringify(after.map((group) => group.tabOrder))
      },
      { timeout: 15_000 }
    )
    .toBe(JSON.stringify(expectedOrders))
    .catch(() => undefined)
  const orders = JSON.stringify(after.map((group) => group.tabOrder))
  run.expectNone(
    `${step}: group tab orders`,
    orders === JSON.stringify(expectedOrders)
      ? []
      : [`groups ${orders}, expected ${JSON.stringify(expectedOrders)}`]
  )
  const selection = after.flatMap((group) => {
    const kept = before.find((candidate) => candidate.id === group.id)?.activeTabId
    const expected = group.tabOrder.includes(move.tabId)
      ? move.tabId
      : kept && group.tabOrder.includes(kept)
        ? kept
        : (group.tabOrder[0] ?? null)
    return group.activeTabId === expected
      ? []
      : [`group ${group.id} selects ${group.activeTabId}, expected ${expected}`]
  })
  run.expectNone(`${step}: selection`, selection)
  return after
}

const SCENARIOS: Scenario[] = [
  {
    // #23429: a client-created and a CLI-created tab in one worktree must both stay listed.
    id: 'mixed-create-warm-restart',
    journey: async (run) => {
      await createTab(run, run.a)
      await run.check('client creates tab', [1])
      await createTerminal(run)
      await run.check('CLI creates terminal', [1, 1])
      await run.restart('warm restart', [1, 1])
    }
  },
  {
    // #19582: a rename must show in every view, and survive a restart.
    id: 'rename-terminal',
    journey: async (run) => {
      const created = await createTerminal(run)
      await run.check('create', [1])
      const tabId = created.tabId ?? (await listTerminals(run.cli, run.worktree))[0]!.tabId
      await run.a.call('terminal.rename', { terminal: created.handle, title: 'oracle-renamed' })
      await run.check('rename', [1])
      const views = [
        { name: 'client', client: run.a },
        { name: 'cli', client: run.cli }
      ]
      const wrong = (titles: string[]) =>
        titles.filter((line) => !line.endsWith('"oracle-renamed"'))
      run.expectNone('rename shows', wrong(await titlesOf(run, tabId, views)))
      await run.restart('warm restart', [1])
      run.expectNone('rename after restart', wrong(await titlesOf(run, tabId, views)))
    }
  },
  {
    // #10747: closing a CLI-created terminal by handle succeeds and removes the tab everywhere.
    id: 'close-terminal-by-handle',
    journey: async (run) => {
      const created = await createTerminal(run)
      await run.check('create', [1])
      await attempt(run, 'close by handle', () =>
        run.a.call('terminal.close', { terminal: created.handle })
      )
      await run.check('close by handle', [], undefined, 1)
    }
  },
  {
    // #25794: closed tabs must not come back after a restart, and no extra tab appears.
    id: 'closed-tabs-stay-closed',
    journey: async (run) => {
      const first = await createTab(run, run.a)
      const second = await createTab(run, run.a)
      const third = await createTab(run, run.a)
      await run.check('three tabs', [1, 1, 1])
      await attempt(run, 'client closes first', () =>
        run.a.call('session.tabs.close', { worktree: run.worktree, tabId: first, reason: 'user' })
      )
      await run.check('client closes first', [1, 1], undefined, 1)
      const handle = await handleForTab(run, second)
      await attempt(run, 'CLI closes second', () =>
        run.cli.call('terminal.close', { terminal: handle })
      )
      await run.check('CLI closes second', [1], undefined, 1)
      await run.restart('warm restart', [1])
      const left = readHeadlessPartitions(run.host.userDataDir)
        .flatMap(({ session }) => session.tabsByWorktree?.[run.worktreeId] ?? [])
        .map((tab) => tab.id)
      run.expectNone(
        'survivor after restart',
        left.length === 1 && left[0] === third
          ? []
          : [`tabs ${JSON.stringify(left)}, expected only ${third}`]
      )
    }
  },
  {
    // #9450: client A creates, client B closes; both clients, the CLI and the runtime agree.
    id: 'two-clients-create-close',
    journey: async (run) => {
      const views = [
        { name: 'client A', client: run.a },
        { name: 'client B', client: run.b },
        { name: 'cli', client: run.cli }
      ]
      const first = await createTab(run, run.a)
      await createTab(run, run.a)
      await run.check('A creates two tabs', [1, 1], views)
      await attempt(run, 'B closes one', () =>
        run.b.call('session.tabs.close', { worktree: run.worktree, tabId: first, reason: 'user' })
      )
      await run.check('B closes one', [1], views, 1)
    }
  },
  {
    // A tab split off into a new group keeps its terminal; the group it left selects its first tab.
    id: 'split-tab-into-new-group',
    journey: async (run) => {
      const first = await createTab(run, run.a)
      const second = await createTab(run, run.a)
      await run.check('two tabs', [1, 1])
      const [group] = await groupsOf(run)
      await moveTab(
        run,
        'split second tab right',
        { kind: 'split', tabId: second, targetGroupId: group!.id, splitDirection: 'right' },
        [[first], [second]]
      )
      await run.check('split into new group', [1, 1])
      await run.restart('warm restart', [1, 1])
    }
  },
  {
    // Moves between groups and a reorder; a group emptied by a move closes.
    id: 'move-tab-between-groups',
    journey: async (run) => {
      const first = await createTab(run, run.a)
      const second = await createTab(run, run.a)
      const third = await createTab(run, run.a)
      await run.check('three tabs', [1, 1, 1])
      const [source] = await groupsOf(run)
      const [, target] = await moveTab(
        run,
        'split third tab right',
        { kind: 'split', tabId: third, targetGroupId: source!.id, splitDirection: 'right' },
        [[first, second], [third]]
      )
      await moveTab(
        run,
        'move second tab into the new group',
        { kind: 'move-to-group', tabId: second, targetGroupId: target!.id, index: 0 },
        [[first], [second, third]]
      )
      await run.check('move to group', [1, 1, 1])
      await moveTab(
        run,
        'reorder the new group',
        { kind: 'reorder', tabId: third, targetGroupId: target!.id, tabOrder: [third, second] },
        [[first], [third, second]]
      )
      await run.check('reorder', [1, 1, 1])
      await moveTab(
        run,
        'move the last tab out of the first group',
        { kind: 'move-to-group', tabId: first, targetGroupId: target!.id, index: 2 },
        [[third, second, first]]
      )
      await run.check('emptied group closes', [1, 1, 1])
      await run.restart('warm restart', [1, 1, 1])
    }
  },
  {
    id: 'split-close-pane-restarts',
    journey: async (run) => {
      const created = await createTerminal(run)
      await run.check('create', [1])
      const split = await run.a.call<{ split: RuntimeTerminalSplit }>('terminal.split', {
        terminal: created.handle,
        direction: 'horizontal'
      })
      await run.check('split', [2])
      await attempt(run, 'close split pane', () =>
        run.a.call('terminal.close', { terminal: split.result.split.handle })
      )
      await run.check('close split pane', [1], undefined, 1)
      await run.restart('warm restart', [1])
      await run.restart('cold restart', [1], true)
    }
  }
]

async function runHeadlessScenario(
  testInfo: TestInfo,
  kind: HeadlessHostKind,
  scenario: Scenario
): Promise<OracleFinding[]> {
  const host = await startHeadlessOracleHost(kind)
  const started = Date.now()
  let findings: OracleFinding[] = []
  try {
    const a = pairedClient(host, 'a')
    const cli = cliClient(host)
    const worktreeId = await addRepoWorktree(host, cli)
    const target = (client: RuntimeClient) => ({
      client,
      readPartitions: async () => readHeadlessPartitions(host.userDataDir),
      worktreeIds: () => [worktreeId]
    })
    const oracle = new LayoutOracle(target(a))
    findings = oracle.findings
    // A cold restart gives every pane a new terminal.
    let restarting = false
    const check: Run['check'] = async (label, panesPerTab, views, removed = 0) => {
      const list = views ?? [
        { name: 'client', client: a },
        { name: 'cli', client: cli }
      ]
      let layout: OracleLayout = {}
      for (const [index, view] of list.entries()) {
        await oracle.retarget(target(view.client))
        const step = index === 0 ? label : `${label} (${view.name} view)`
        // Later views re-read the same layout, so only the first sees the removal.
        layout = await oracle.step(step, {
          worktreeId,
          panesPerTab,
          ...(index === 0 ? { removed } : {}),
          ...(index === 0 && restarting ? { terminalsRestart: true } : {})
        })
      }
      await oracle.retarget(target(a))
      return layout
    }
    const run: Run = {
      host,
      worktreeId,
      worktree: `id:${worktreeId}`,
      a,
      b: pairedClient(host, 'b'),
      cli,
      oracle,
      check,
      restart: async (label, panesPerTab, cold) => {
        oracle.rememberForRestart(await check(`before ${label}`, panesPerTab))
        await host.restart({ cold })
        restarting = cold === true
        const after = await check(`after ${label}`, panesPerTab)
        restarting = false
        oracle.compareRestart(label, after, { maskPtyIds: cold })
      },
      expectNone: (step, details) => {
        if (details.length > 0) {
          oracle.findings.push({ check: 'expected', step, details })
        }
      }
    }
    await oracle.start()
    try {
      await run.check('start', [])
      await scenario.journey(run)
    } finally {
      await oracle.stop()
    }
    return findings
  } finally {
    writeReport(testInfo, `${kind}-${scenario.id}`, findings, Date.now() - started)
    await host.dispose()
  }
}

function writeReport(
  testInfo: TestInfo,
  scenarioId: string,
  findings: OracleFinding[],
  durationMs: number
): void {
  const dir = process.env[ORACLE_REPORT_DIR_ENV] ?? testInfo.outputPath('layout-oracle')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `headless-${scenarioId}-${Date.now()}.json`)
  writeFileSync(
    file,
    `${JSON.stringify({ scenario: `headless-${scenarioId}`, durationMs, findings }, null, 2)}\n`
  )
}

const REPEAT = Math.max(1, Number(process.env.ORCA_LAYOUT_ORACLE_REPEAT ?? 1))
const RECORD_ONLY = process.env.ORCA_LAYOUT_ORACLE_RECORD === '1'
const HOSTS = (process.env.ORCA_LAYOUT_ORACLE_HEADLESS_HOSTS ?? 'orcad,electron')
  .split(',')
  .filter((kind): kind is HeadlessHostKind => kind === 'orcad' || kind === 'electron')

for (const kind of HOSTS) {
  for (const scenario of SCENARIOS) {
    for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
      const suffix = REPEAT > 1 ? ` #${attempt}` : ''
      // oxlint-disable-next-line no-empty-pattern -- Each scenario owns its serve host.
      test(`headless layout oracle: ${kind} ${scenario.id}${suffix}`, async ({}, testInfo) => {
        // CI runs this spec only in the job that builds orcad, so a missing build there is a failure.
        test.skip(
          kind === 'orcad' && !orcadNodeExecutable() && !process.env.CI,
          'out/orcad is not built'
        )
        test.setTimeout(300_000)
        const id = `headless-${kind}-${scenario.id}`
        const findings = await runHeadlessScenario(testInfo, kind, scenario)
        for (const finding of findings) {
          console.log(
            `[layout-oracle] ${id}: ${finding.check} @ ${finding.step}\n  ${finding.details.join('\n  ')}`
          )
        }
        if (!RECORD_ONLY) {
          expect(unexpectedFindings(id, findings)).toEqual([])
        }
      })
    }
  }
}
