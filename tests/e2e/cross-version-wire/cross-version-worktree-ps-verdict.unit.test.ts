import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The verdict on a `worktree ps` agent row, paired across two builds.
 *
 * The host now sends `mainAgent` (the main agent's own state, verdict and clock) on each row,
 * beside the `interrupted` flag every build reads. That is Rule 1 only if an old phone still reads
 * a new host's row by the flag, and a new phone reads an old host's row, which has no `mainAgent`,
 * by the same flag. Both halves run a real old build here rather than being reasoned about.
 *
 * The pre-change ref is pinned rather than derived: a newer baseline would carry the new reader,
 * and every "old reader" cell would then pair the change against itself.
 */
const PRE_CHANGE_REF = 'v1.4.212'
const SUITE_TIMEOUT_MS = 180_000

const WORKTREE_ID = 'repo::/worktree'
const NOW = 1_000_000

type HookSnapshot = Record<string, unknown>
type AgentRow = Record<string, unknown>
type DotState = (row: AgentRow, now: number) => string

type HostRowModules = {
  collectRuntimeWorktreeAgentSources: (args: Record<string, unknown>) => unknown
  attachRuntimeWorktreeAgentRows: (args: Record<string, unknown>) => void
}

type Build = {
  label: string
  host: HostRowModules
  agentDotState: DotState
}

function snapshot(
  tabId: string,
  fields: Pick<HookSnapshot, 'state'> & Partial<HookSnapshot>
): HookSnapshot {
  return {
    paneKey: `${tabId}:11111111-1111-4111-8111-111111111111`,
    tabId,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    prompt: 'ship it',
    agentType: 'claude',
    receivedAt: NOW - 1_000,
    stateStartedAt: NOW - 600_000,
    ...fields
  }
}

// The three verdicts the change separates: a failure the old flag cannot express, the same
// failure while subagents keep the row working, and a stop the old flag already carries.
const SNAPSHOTS: HookSnapshot[] = [
  snapshot('failed-done', {
    state: 'done',
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 600_000 }
  }),
  snapshot('failed-working', {
    state: 'working',
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 120_000 }
  }),
  snapshot('stopped', {
    state: 'done',
    interrupted: true,
    mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: NOW - 600_000 }
  })
]

/** A host's `worktree ps` rows, JSON round-tripped as the wire carries them. */
function publishRows(host: HostRowModules): Record<string, AgentRow> {
  const summary: Record<string, unknown> = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  }
  host.attachRuntimeWorktreeAgentRows({
    summaries: new Map([[WORKTREE_ID, summary]]),
    pathIndex: { byPath: new Map(), byRealPath: new Map() },
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources: host.collectRuntimeWorktreeAgentSources({
      hookSnapshots: SNAPSHOTS,
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set(SNAPSHOTS.map((row) => row.tabId)),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map()
      }
    }),
    orchestrationByPaneKey: null,
    getSummary: (map: Map<string, unknown>, _paths: unknown, _missing: unknown, id: string) =>
      map.get(id) ?? null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse of the rows the host just attached, which are plain objects keyed by paneKey.
  const rows = JSON.parse(JSON.stringify(summary.agents)) as AgentRow[]
  return Object.fromEntries(rows.map((row) => [String(row.paneKey).split(':')[0], row]))
}

function dotStates(build: Build, rows: Record<string, AgentRow>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rows).map(([tabId, row]) => [tabId, build.agentDotState(row, NOW)])
  )
}

async function loadBuild(ref: string | null): Promise<Build> {
  if (ref === null) {
    const [sources, rows, display] = await Promise.all([
      import('../../../src/main/runtime/runtime-worktree-agent-sources'),
      import('../../../src/main/runtime/runtime-worktree-agent-rows'),
      import('../../../mobile/src/worktree/agent-row-display')
    ])
    return {
      label: 'current',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed by its module; this spec drives both builds through one untyped surface.
      host: { ...sources, ...rows } as unknown as HostRowModules,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same surface as the old build's export, read without either build's row type.
      agentDotState: display.agentDotState as unknown as DotState
    }
  }
  const checkout = await materializeReleaseCheckout(ref)
  const [sources, rows, display] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/runtime-worktree-agent-sources.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/runtime-worktree-agent-rows.ts'),
    importReleaseCheckoutModule(checkout, 'mobile/src/worktree/agent-row-display.ts')
  ])
  return {
    label: ref,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; these two modules are the old host's row surface by path.
    host: { ...sources, ...rows } as unknown as HostRowModules,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; this is the old phone's row reader by path.
    agentDotState: display.agentDotState as unknown as DotState
  }
}

let oldBuild: Build
let newBuild: Build
let agentRowTimeAt: (row: AgentRow) => number

beforeAll(async () => {
  ;[oldBuild, newBuild] = await Promise.all([loadBuild(PRE_CHANGE_REF), loadBuild(null)])
  const display = await import('../../../mobile/src/worktree/agent-row-display')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows are JSON the current host published, so the current reader's row type holds.
  agentRowTimeAt = display.agentRowTimeAt as unknown as (row: AgentRow) => number
}, SUITE_TIMEOUT_MS)

describe('cross-version worktree ps verdict', () => {
  it('pairs two real builds that disagree on the row shape', () => {
    // Anti-vacuous-pass oracle: one module resolved twice would make every cell same-version.
    expect(oldBuild.agentDotState).not.toBe(newBuild.agentDotState)
    expect(Object.values(publishRows(oldBuild.host)).some((row) => 'mainAgent' in row)).toBe(false)
    expect(Object.values(publishRows(newBuild.host)).every((row) => 'mainAgent' in row)).toBe(true)
  })

  it('an OLD phone reads a new host row by the interrupted flag it always read', () => {
    const rows = publishRows(newBuild.host)
    expect(rows.stopped).toMatchObject({ interrupted: true })
    expect(dotStates(oldBuild, rows)).toEqual({
      'failed-done': 'done',
      'failed-working': 'working',
      stopped: 'interrupted'
    })
  })

  it('a NEW phone reads an old host row, which has no mainAgent, by the same flag', () => {
    const rows = publishRows(oldBuild.host)
    expect(dotStates(newBuild, rows)).toEqual({
      'failed-done': 'done',
      'failed-working': 'working',
      stopped: 'interrupted'
    })
    // Without the main agent's clock the row dates itself, as it always did.
    expect(agentRowTimeAt(rows['failed-working'])).toBe(NOW - 600_000)
  })

  it('a NEW phone reads a new host failure as failed, dated by the main agent clock', () => {
    const rows = publishRows(newBuild.host)
    expect(dotStates(newBuild, rows)).toEqual({
      'failed-done': 'failed',
      'failed-working': 'failed',
      stopped: 'interrupted'
    })
    expect(rows['failed-working']).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: NOW - 120_000 }
    })
    expect(agentRowTimeAt(rows['failed-working'])).toBe(NOW - 120_000)
  })
})
