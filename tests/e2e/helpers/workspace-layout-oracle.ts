/**
 * Runs the layout checks after each scenario step and records which check fired.
 *
 * - rules: the runtime's layout breaks a structural rule (also on transient reads while settling),
 *   or an id changed for the same pane, tab or group since the previous step.
 * - view: what the window draws differs from the runtime's layout.
 * - client: what a paired client / the CLI is told differs from the runtime's layout.
 * - expected: the runtime's layout is not the one the scenario's commands should produce.
 * - restart: the layout after a relaunch (or PTY daemon restart) differs from before it.
 * - marker: text written to a pane's terminal never shows in that pane (a frozen or crossed pane).
 * - remount: a pane's terminal view was created again in the same window outside a restart.
 *
 * Between checkpoints a sampler runs the rules every 100 ms; a breach that heals before the next
 * step is recorded as transient.
 */

import type { Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime/client'
import {
  checkWorkspaceLayoutRules,
  diffOracleLayouts,
  formatViolations,
  toOracleLayout,
  type OracleLayout,
  type WorkspaceLayoutPartition
} from './workspace-layout-oracle-model'
import { compareClientToRuntime, compareDrawnToRuntime } from './workspace-layout-oracle-compare'
import { readClientView, readDrawnLayout, type ClientView } from './workspace-layout-oracle-views'
import { expectedDifferences, type ExpectedLayout } from './workspace-layout-oracle-expected'
import { checkLayoutRoundTrip } from '../../../src/shared/workspace-layout/workspace-layout-round-trip-check'
import { checkPaneMarkers } from './workspace-layout-oracle-markers'
import {
  installRemountCounter,
  LayoutRuleSampler,
  readRemountCounts
} from './workspace-layout-oracle-watch'

export type OracleCheck =
  | 'rules'
  | 'view'
  | 'client'
  | 'expected'
  | 'restart'
  | 'marker'
  | 'remount'
  | 'roundTrip'
export type OracleFinding = {
  check: OracleCheck
  step: string
  details: string[]
  /** What each side held when the finding was recorded, for the report only. */
  evidence?: unknown
}

export type OracleTarget = {
  /** The window, when one is attached; a headless runtime has none. */
  page?: Page
  client: RuntimeClient
  readPartitions: () => Promise<WorkspaceLayoutPartition[]>
  /** Worktrees whose client view is compared; the scenario's own worktrees. */
  worktreeIds: () => string[]
}

export type { ExpectedLayout }

const SETTLE_TIMEOUT_MS = Number(process.env.ORCA_LAYOUT_ORACLE_SETTLE_MS ?? 12_000)
const POLL_MS = 300

type ViewRead = { view: string[]; client: string[]; evidence: Record<string, unknown> }

function summarizeClientView(view: ClientView): unknown {
  return {
    worktreeId: view.worktreeId,
    error: view.error,
    publicationEpoch: view.tabs?.publicationEpoch,
    groups: view.tabs?.tabGroups?.map((group) => [group.id, group.tabOrder]),
    panes: view.tabs?.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [[tab.parentTabId, tab.leafId, tab.ptyId ?? null, tab.title]] : []
    ),
    terminals: view.terminals.map((terminal) => [
      terminal.tabId,
      terminal.leafId,
      terminal.ptyId,
      terminal.orphaned ?? false
    ])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type StepOptions = {
  /** The step may recreate existing panes' terminal views (relaunch, daemon restart). */
  allowRemount?: true
}

export class LayoutOracle {
  readonly findings: OracleFinding[] = []
  private previous: WorkspaceLayoutPartition[] | null = null
  private previousLayout: OracleLayout | null = null
  private snapshot: OracleLayout | null = null
  private remountBaseline: Record<string, number> = {}
  /** Terminal views created per pane in the current window, for the report (and a precondition). */
  readonly viewCreations: Record<string, number>[] = []
  private readonly sampler: LayoutRuleSampler

  constructor(private target: OracleTarget) {
    this.sampler = new LayoutRuleSampler(target.readPartitions)
  }

  /** Starts the between-steps sampler and, with a window, the remount counter. */
  async start(): Promise<void> {
    if (this.target.page) {
      await installRemountCounter(this.target.page)
    }
    this.sampler.start()
  }

  async stop(): Promise<void> {
    await this.sampler.stop()
  }

  /** After a relaunch: new window, new renderer, so remounts count from zero again. */
  async retarget(target: OracleTarget): Promise<void> {
    this.target = target
    this.sampler.retarget(target.readPartitions)
    this.remountBaseline = {}
    if (target.page) {
      await installRemountCounter(target.page)
    }
  }

  private record(check: OracleCheck, step: string, details: string[], evidence?: unknown): void {
    if (details.length > 0) {
      this.findings.push({ check, step, details: [...new Set(details)], evidence })
    }
  }

  private async readViews(partitions: WorkspaceLayoutPartition[]): Promise<ViewRead> {
    const { page, client } = this.target
    const clientViews = await Promise.all(
      this.target.worktreeIds().map((worktreeId) => readClientView(client, worktreeId))
    )
    // A pane keeps its binding after its terminal exits or sleeps; the window then draws none.
    const live = new Set(
      clientViews.flatMap((view) => view.terminals.flatMap((terminal) => terminal.ptyId ?? []))
    )
    const drawn = page ? await readDrawnLayout(page) : null
    const view = drawn ? compareDrawnToRuntime(partitions, drawn, live) : []
    if (drawn && drawn.strips.length === 0) {
      view.push('the window draws no tab strip')
    }
    return {
      view,
      client: clientViews.flatMap((view) => compareClientToRuntime(partitions, view)),
      evidence: { drawn, clients: clientViews.map(summarizeClientView) }
    }
  }

  /**
   * Waits until the runtime's layout is stable and every view agrees with it, then records what
   * still differs. Views may lag the runtime; only a difference that outlives the wait counts.
   */
  async step(
    label: string,
    expected: ExpectedLayout | null,
    options: StepOptions = {}
  ): Promise<OracleLayout> {
    const transient = new Set<string>()
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    let last = ''
    let stableReads = 0
    let partitions: WorkspaceLayoutPartition[] = []
    let differences: ViewRead = { view: [], client: [], evidence: {} }
    for (;;) {
      partitions = await this.target.readPartitions()
      for (const line of formatViolations(checkWorkspaceLayoutRules(partitions))) {
        transient.add(line)
      }
      const serialized = JSON.stringify(toOracleLayout(partitions))
      stableReads = serialized === last ? stableReads + 1 : 0
      last = serialized
      differences = await this.readViews(partitions)
      const agreed = differences.view.length === 0 && differences.client.length === 0
      if ((agreed && stableReads >= 2) || Date.now() > deadline) {
        break
      }
      await sleep(POLL_MS)
    }
    const settled = formatViolations(
      checkWorkspaceLayoutRules(partitions, this.previous ?? undefined)
    )
    this.record('rules', label, settled)
    // The shadow self-check: each partition loads and saves to a fixed point (Loader, Serializer).
    this.record(
      'roundTrip',
      label,
      partitions.flatMap(({ hostId, session }) =>
        checkLayoutRoundTrip(hostId, session).findings.map(
          (finding) => `${hostId} ${JSON.stringify(finding)}`
        )
      )
    )
    const between = this.sampler.take(this.sampler.label)
    this.record(
      'rules',
      `${label} (transient)`,
      [...new Set([...between, ...transient])].filter((line) => !settled.includes(line))
    )
    this.sampler.label = label
    const layout = toOracleLayout(partitions)
    const evidence = { runtime: layout, ...differences.evidence }
    this.record('view', label, differences.view, evidence)
    this.record('client', label, differences.client, evidence)
    if (expected) {
      this.record(
        'expected',
        label,
        expectedDifferences(layout, expected, this.previousLayout),
        evidence
      )
    }
    await this.checkRemounts(label, options)
    this.previous = partitions
    this.previousLayout = layout
    return layout
  }

  private async checkRemounts(label: string, options: StepOptions): Promise<void> {
    const { page } = this.target
    if (!page) {
      return
    }
    const counts = await readRemountCounts(page)
    const remounted = Object.entries(counts).filter(
      ([leafId, count]) =>
        (this.remountBaseline[leafId] ?? 0) > 0 && count > this.remountBaseline[leafId]!
    )
    if (!options.allowRemount) {
      this.record(
        'remount',
        label,
        remounted.map(
          ([leafId, count]) => `pane ${leafId}'s terminal view was created ${count} times`
        )
      )
    }
    this.remountBaseline = counts
    this.viewCreations.push(counts)
  }

  /** Remember the settled layout so `compareRestart` can diff the relaunched runtime against it. */
  rememberForRestart(layout: OracleLayout): void {
    this.snapshot = layout
  }

  compareRestart(
    label: string,
    layout: OracleLayout,
    options: { maskPtyIds?: boolean } = {}
  ): void {
    if (!this.snapshot) {
      throw new Error('compareRestart called before rememberForRestart')
    }
    // No empty passes: an empty layout before the restart proves nothing about the restart.
    if (Object.keys(this.snapshot).length === 0) {
      this.record('restart', label, ['the layout before the restart was empty'])
      return
    }
    this.record(
      'restart',
      label,
      diffOracleLayouts(this.snapshot, layout, { ...options, label: 'after restart' })
    )
  }

  async checkMarkers(label: string, worktreeId: string): Promise<void> {
    const { page, client } = this.target
    if (page) {
      this.record('marker', label, await checkPaneMarkers(page, client, worktreeId))
    }
  }
}
