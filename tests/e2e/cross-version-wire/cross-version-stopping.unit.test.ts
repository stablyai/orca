import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  importWorkingTreeModuleCopy,
  materializeReleaseCheckout
} from './release-checkout'

/**
 * "Stopping…", paired across two builds.
 *
 * The host now publishes `stopping: true` on a working session's status summary, and the main
 * agent's row carries it as `mainAgent.stopping`. Both are optional fields an older reader must
 * ignore (Rule 1): an old desktop folds a new host's summary into a plain working row, and an old
 * phone reads a new host's `worktree ps` row as working with its usual line. A new reader of an old
 * host, which never publishes either field, must never read Stopping from it.
 *
 * The pre-change ref is pinned rather than derived: a newer baseline would carry the new reader.
 */
const PRE_CHANGE_REF = 'v1.4.214'
const SUITE_TIMEOUT_MS = 180_000
const STATUS_FOLD = 'src/shared/structured-agent-session-agent-status.ts'
// Both builds load a copy in the checkout cache, out of reach of `mobile/tsconfig.json`.
const PHONE_ROW_READER = 'mobile/src/worktree/agent-row-display.ts'
const PROTOCOL_VERSION = 'src/shared/protocol-version.ts'
const MOBILE_ALLOWLIST = 'src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist.ts'
const STATUS_STREAM = 'agentSession.subscribeStatus'

const WORKTREE_ID = 'repo::/worktree'
const NOW = 1_000_000

type Summary = Record<string, unknown>
type Row = Record<string, unknown>
type Fold = (summary: Summary) => { state: string; mainAgent: Record<string, unknown> }

type HostRowModules = {
  collectRuntimeWorktreeAgentSources: (args: Record<string, unknown>) => unknown
  attachRuntimeWorktreeAgentRows: (args: Record<string, unknown>) => void
}

type Build = {
  fold: Fold
  agentDotState: (row: Row, now: number) => string
  agentDisplayLabel: (row: Row, now: number) => string
  host: HostRowModules
}

/** A working session's summary as the new host publishes it, JSON round-tripped. */
const STOPPING_SUMMARY: Summary = JSON.parse(
  JSON.stringify({
    sessionId: 'session-1',
    workspaceId: WORKTREE_ID,
    agent: 'claude',
    status: 'working',
    latestPrompt: 'ship it',
    updatedAt: NOW,
    stopping: true
  })
)

/** A host's `worktree ps` rows for one structured session, JSON round-tripped. */
function publishRow(host: HostRowModules, mainAgent: Record<string, unknown>): Row {
  const summary: Record<string, unknown> = {
    worktreeId: WORKTREE_ID,
    status: 'inactive',
    hasHostSidebarActivity: false,
    agents: []
  }
  const snapshot = {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    structuredHost: 'owned',
    state: 'working',
    prompt: 'ship it',
    lastAssistantMessage: 'running the tests',
    agentType: 'claude',
    receivedAt: NOW - 1_000,
    stateStartedAt: NOW - 60_000,
    mainAgent
  }
  host.attachRuntimeWorktreeAgentRows({
    summaries: new Map([[WORKTREE_ID, summary]]),
    pathIndex: { byPath: new Map(), byRealPath: new Map() },
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources: host.collectRuntimeWorktreeAgentSources({
      hookSnapshots: [snapshot],
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set(),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map()
      }
    }),
    orchestrationByPaneKey: null,
    getSummary: (map: Map<string, unknown>, _paths: unknown, _missing: unknown, id: string) =>
      map.get(id) ?? null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse of the rows the host just attached, which are plain objects.
  const [row] = JSON.parse(JSON.stringify(summary.agents)) as Row[]
  if (!row) {
    throw new Error('expected one row')
  }
  return row
}

async function loadBuild(ref: string | null): Promise<Build> {
  if (ref === null) {
    const [fold, display, sources, rows] = await Promise.all([
      import('../../../src/shared/structured-agent-session-agent-status'),
      importWorkingTreeModuleCopy(PHONE_ROW_READER),
      import('../../../src/main/runtime/runtime-worktree-agent-sources'),
      import('../../../src/main/runtime/runtime-worktree-agent-rows')
    ])
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this spec drives both builds' fold through one untyped surface.
      fold: fold.structuredAgentSessionAgentStatus as unknown as Fold,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import of a copy is typed unknown; this is the current phone's row reader by path.
      agentDotState: display.agentDotState as unknown as Build['agentDotState'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, the current phone's row label.
      agentDisplayLabel: display.agentDisplayLabel as unknown as Build['agentDisplayLabel'],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed by its module; this spec drives both builds through one untyped surface.
      host: { ...sources, ...rows } as unknown as HostRowModules
    }
  }
  const checkout = await materializeReleaseCheckout(ref)
  const [fold, display, sources, rows] = await Promise.all([
    importReleaseCheckoutModule(checkout, STATUS_FOLD),
    importReleaseCheckoutModule(checkout, PHONE_ROW_READER),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/runtime-worktree-agent-sources.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/runtime-worktree-agent-rows.ts')
  ])
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; this is the old build's summary fold by path.
    fold: fold.structuredAgentSessionAgentStatus as unknown as Fold,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; this is the old phone's row reader by path.
    agentDotState: display.agentDotState as unknown as Build['agentDotState'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, the old phone's row label.
    agentDisplayLabel: display.agentDisplayLabel as unknown as Build['agentDisplayLabel'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed unknown; these two modules are the old host's row surface by path.
    host: { ...sources, ...rows } as unknown as HostRowModules
  }
}

let oldBuild: Build
let newBuild: Build

beforeAll(async () => {
  ;[oldBuild, newBuild] = await Promise.all([loadBuild(PRE_CHANGE_REF), loadBuild(null)])
}, SUITE_TIMEOUT_MS)

describe('cross-version Stopping', () => {
  it('pairs two real builds that disagree on the field', () => {
    // Anti-vacuous-pass oracle: one module resolved twice would make every cell same-version.
    expect(oldBuild.fold).not.toBe(newBuild.fold)
    expect(newBuild.fold(STOPPING_SUMMARY).mainAgent).toMatchObject({ stopping: true })
    expect(oldBuild.fold(STOPPING_SUMMARY).mainAgent).not.toHaveProperty('stopping')
  })

  it('an OLD desktop folds a new host summary into the plain working row it always drew', () => {
    expect(oldBuild.fold(STOPPING_SUMMARY)).toEqual({
      state: 'working',
      mainAgent: { state: 'working' }
    })
  })

  it("an OLD phone reads a new host's row as working, with its usual line", () => {
    const row = publishRow(newBuild.host, {
      state: 'working',
      stopping: true,
      stateStartedAt: NOW - 60_000
    })
    expect(row.mainAgent).toMatchObject({ stopping: true })
    expect(oldBuild.agentDotState(row, NOW)).toBe('working')
    expect(oldBuild.agentDisplayLabel(row, NOW)).toBe('running the tests')
    expect(newBuild.agentDisplayLabel(row, NOW)).toBe('Stopping…')
  })

  it('a NEW reader of an old host never reads Stopping, which that host never publishes', () => {
    const { stopping: _stopping, ...oldSummary } = STOPPING_SUMMARY
    expect(newBuild.fold(oldSummary)).toEqual({ state: 'working', mainAgent: { state: 'working' } })
    const row = publishRow(oldBuild.host, { state: 'working', stateStartedAt: NOW - 60_000 })
    expect(newBuild.agentDotState(row, NOW)).toBe('working')
    expect(newBuild.agentDisplayLabel(row, NOW)).toBe('running the tests')
  })

  // The phone's chat reads Stopping from the status stream only on a host that lets phones call it.
  it('an OLD host advertising the status feed refuses it to a NEW phone, which reads that as no feed', async () => {
    const checkout = await materializeReleaseCheckout(PRE_CHANGE_REF)
    const [oldProtocol, oldAllowlist, newProtocol, newAllowlist] = await Promise.all([
      importReleaseCheckoutModule(checkout, PROTOCOL_VERSION),
      importReleaseCheckoutModule(checkout, MOBILE_ALLOWLIST),
      import('../../../src/shared/protocol-version'),
      import('../../../src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist')
    ])
    const capability = newProtocol.AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY
    expect(oldProtocol.RUNTIME_CAPABILITIES).toContain(capability)
    // Anti-vacuous oracle: the old Set answers membership for a method it does grant phones.
    expect(oldAllowlist.MOBILE_RPC_METHOD_ALLOWLIST).toContain('agentSession.subscribe')
    // The capability alone is no grant: this host's mobile gate answers `forbidden`, which the
    // phone's feed reads as absence (mobile-structured-session-status-feed.test.ts).
    expect(oldAllowlist.MOBILE_RPC_METHOD_ALLOWLIST).not.toContain(STATUS_STREAM)
    expect(newProtocol.RUNTIME_CAPABILITIES).toContain(capability)
    expect(newAllowlist.MOBILE_RPC_METHOD_ALLOWLIST.has(STATUS_STREAM)).toBe(true)
  })
})
