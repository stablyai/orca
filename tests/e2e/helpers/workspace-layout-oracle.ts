/**
 * Runs the layout checks after each scenario step and records which check fired. The runtime's
 * layout is read live from its `layout.subscribe` stream.
 *
 * - rules: the runtime's layout breaks a model rule (on every published frame, so a breach that
 *   heals before the step settles is recorded as transient), or an id changed for the same pane,
 *   tab or group since the previous step; or the saved profile breaks a disk-format rule.
 * - roundTrip: a saved partition does not load and save to a fixed point.
 * - view: what the window draws differs from the runtime's layout.
 * - client: what a paired client / the CLI is told differs from the runtime's layout.
 * - expected: the runtime's layout is not the one the scenario's commands should produce.
 * - restart: the layout after a relaunch (or PTY daemon restart) differs from before it.
 * - marker: text written to a pane's terminal never shows in that pane (a frozen or crossed pane).
 * - remount: a pane's terminal view was created again in the same window outside a restart.
 */

import type { Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime/client'
import type { WorkspaceLayoutModel } from '../../../src/shared/workspace-layout/workspace-layout-model'
import {
  checkWorkspaceLayoutModelRules,
  checkWorkspaceLayoutRules,
  diffOracleLayouts,
  formatViolations,
  toOracleLayout,
  type OracleLayout,
  type WorkspaceLayoutPartition
} from './workspace-layout-oracle-model'
import {
  liveLayoutModels,
  type LiveLayoutFeed,
  type LiveWorkspace
} from './workspace-layout-oracle-feed'
import { compareClientToRuntime, compareDrawnToRuntime } from './workspace-layout-oracle-compare'
import { readClientView, readDrawnLayout, type ClientView } from './workspace-layout-oracle-views'
import { expectedDifferences, type ExpectedLayout } from './workspace-layout-oracle-expected'
import { checkLayoutRoundTrip } from '../../../src/shared/workspace-layout/workspace-layout-round-trip-check'
import { checkPaneMarkers } from './workspace-layout-oracle-markers'
import { installRemountCounter, readRemountCounts } from './workspace-layout-oracle-watch'
import { unexpectedFindings } from '../workspace-layout-oracle-known-on-main'

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
  /** The runtime's live layout; the same feed across retargets of one run. */
  feed: LiveLayoutFeed
  /** The saved profile, read once a step settles for the disk-format rules and the round trip. */
  readSavedPartitions: () => Promise<WorkspaceLayoutPartition[]>
  /** Worktrees whose client view is compared; the scenario's own worktrees. */
  worktreeIds: () => string[]
}

export type { ExpectedLayout }

const SETTLE_TIMEOUT_MS = Number(process.env.ORCA_LAYOUT_ORACLE_SETTLE_MS ?? 12_000)
// Views (the window's drawing, session.tabs.list, terminal.list) catch up after the runtime's last
// frame with no event of their own, so the step re-reads them on this interval until they agree.
const VIEW_CONVERGENCE_POLL_MS = 300
// Today's quiet window (three reads, ~600 ms): no frame across this many gaps between reads.
const QUIET_GAPS = 2

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

/** A model-rule breach line → the step label current when a frame first showed it. */
type FrameBreaches = Map<string, string>

export class LayoutOracle {
  readonly findings: OracleFinding[] = []
  private previousModels: WorkspaceLayoutModel[] | null = null
  private previousSaved: WorkspaceLayoutPartition[] | null = null
  private previousLayout: OracleLayout | null = null
  private snapshot: OracleLayout | null = null
  private remountBaseline: Record<string, number> = {}
  /** Terminal views created per pane in the current window, for the report (and a precondition). */
  readonly viewCreations: Record<string, number>[] = []
  private readonly frameBreaches: FrameBreaches = new Map()
  private label = 'start'

  constructor(
    private target: OracleTarget,
    /** The scenario id the known-on-main list is keyed by. */
    private readonly scenarioId: string
  ) {}

  /** The feed's frame callback: the model rules on every published frame. */
  checkFrame(feed: LiveLayoutFeed): void {
    for (const line of formatViolations(
      checkWorkspaceLayoutModelRules(liveLayoutModels(feed.entries()))
    )) {
      if (!this.frameBreaches.has(line)) {
        this.frameBreaches.set(line, this.label)
      }
    }
  }

  /** With a window, starts the remount counter. */
  async start(): Promise<void> {
    if (this.target.page) {
      await installRemountCounter(this.target.page)
    }
  }

  /** Breaches first seen on a frame while `label` was current, marked as reported. */
  private takeFrameBreaches(label: string): string[] {
    const lines = [...this.frameBreaches]
      .filter(([, seenAt]) => seenAt === label)
      .map(([line]) => line)
    for (const line of lines) {
      this.frameBreaches.set(line, `${label} (reported)`)
    }
    return lines
  }

  /** After a relaunch: new window, new renderer, so remounts count from zero again. */
  async retarget(target: OracleTarget): Promise<void> {
    this.target = target
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

  private async readViews(entries: LiveWorkspace[]): Promise<ViewRead> {
    const { page, client } = this.target
    const clientViews = await Promise.all(
      this.target.worktreeIds().map((worktreeId) => readClientView(client, worktreeId))
    )
    // A pane keeps its binding after its terminal exits or sleeps; the window then draws none.
    const live = new Set(
      clientViews.flatMap((view) => view.terminals.flatMap((terminal) => terminal.ptyId ?? []))
    )
    const drawn = page ? await readDrawnLayout(page) : null
    const view = drawn ? compareDrawnToRuntime(entries, drawn, live) : []
    if (drawn && drawn.strips.length === 0) {
      view.push('the window draws no tab strip')
    }
    return {
      view,
      client: clientViews.flatMap((view) => compareClientToRuntime(entries, view)),
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
    const { feed } = this.target
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    let stableReads = 0
    let lastFrames = -1
    let entries: LiveWorkspace[] = []
    let differences: ViewRead = { view: [], client: [], evidence: {} }
    for (;;) {
      entries = feed.entries()
      differences = await this.readViews(entries)
      // Quiet only if no frame arrived since the previous read, including during the sleep.
      stableReads = feed.ready && feed.frames === lastFrames ? stableReads + 1 : 0
      lastFrames = feed.frames
      // A difference main is known to keep never converges, so it does not hold the wait.
      const agreed =
        unexpectedFindings(this.scenarioId, [
          { check: 'view', step: label, details: differences.view },
          { check: 'client', step: label, details: differences.client }
        ]).length === 0
      if ((agreed && stableReads >= QUIET_GAPS) || Date.now() > deadline) {
        break
      }
      await sleep(VIEW_CONVERGENCE_POLL_MS)
    }
    if (!feed.ready) {
      this.record('rules', label, [
        `no live layout: ${feed.error ?? 'the stream sent no snapshot'}`
      ])
    }
    const models = liveLayoutModels(entries)
    const settled = formatViolations(
      checkWorkspaceLayoutModelRules(models, this.previousModels ?? undefined)
    )
    // The saved profile, which the live stream does not carry: disk-format rules and round trip.
    const saved = await this.target.readSavedPartitions()
    const savedLines = formatViolations(
      checkWorkspaceLayoutRules(saved, this.previousSaved ?? undefined)
    ).map((line) => line.replace(': ', ': saved profile: '))
    this.record('rules', label, [...settled, ...savedLines])
    this.record(
      'roundTrip',
      label,
      saved.flatMap(({ hostId, session }) =>
        checkLayoutRoundTrip(hostId, session).findings.map(
          (finding) => `${hostId} ${JSON.stringify(finding)}`
        )
      )
    )
    this.record(
      'rules',
      `${label} (transient)`,
      this.takeFrameBreaches(this.label).filter((line) => !settled.includes(line))
    )
    this.label = label
    const layout = toOracleLayout(entries)
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
    this.previousModels = models
    this.previousSaved = saved
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
