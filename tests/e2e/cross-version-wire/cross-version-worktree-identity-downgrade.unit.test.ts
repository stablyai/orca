import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The downgrade direction for persisted worktree identity.
 *
 * Upgrade is the easy direction. The risk PR #19955 records is the other one: a user runs a new
 * build, it writes durable state, then they roll back. State the new build wrote must stay
 * readable by the old one.
 *
 * The stack widens `migrateWorktreeIdentity` to repoint the `worktreeId` INSIDE session rows the
 * pre-stack build leaves pointing at the old id. A renamed worktree therefore leaves different
 * bytes on disk depending on which build did the rename, with no wire change anywhere — Rule 3's
 * shape applied to persistence, which is why it is measured here rather than reasoned about.
 */
const PRE_STACK_REF = 'v1.4.199'
const SUITE_TIMEOUT_MS = 180_000

const OLD_ID = 'repo::/worktrees/before'
const NEW_ID = 'repo::/worktrees/after'
const THIRD_ID = 'repo::/worktrees/third'
const PANE_KEY = 'pane-1'

/**
 * Declared locally, NOT as today's `WorkspaceSessionState`: the blob crosses two builds, so typing
 * it against either one would let the current contract rewrite what the other build sees.
 */
type Row = {
  worktreeId: string
}
type CrossVersionSession = {
  tabsByWorktree: Record<string, unknown[]>
  sleepingAgentSessionsByPaneKey: Record<string, Row & { agent: string }>
  terminalSurfaceTombstonesByPaneKey: Record<string, Row & { retiredAt: number }>
  closedTerminalTabTombstonesByTabId: Record<string, Row & { closedAt: number }>
  clientHostedBrowserCloseIntentsByEnvironment: Record<string, (Row & { url: string })[]>
  /** A field neither build under test knows; the forward-compat cells plant it. */
  someFutureFieldByKey?: Record<string, Row & { fromANewerBuild: boolean }>
}
type CrossVersionPersistedState = {
  worktreeMeta: Record<string, { createdAt: number }>
  worktreeLineageById: Record<string, never>
  workspaceLineageByChildKey: Record<string, never>
  workspaceSession: CrossVersionSession
  workspaceSessionsByHostId: Record<string, never>
  mobileClientTabSelectionsByDeviceId: Record<string, never>
  ui: { showDotfilesByWorktree: Record<string, never> }
}
type Migrate = (state: CrossVersionPersistedState, oldId: string, newId: string) => boolean

function isMigrate(value: unknown): value is Migrate {
  return typeof value === 'function'
}

/** What both sides of the skew hand back: a frozen build's namespace and the current one's. */
type MigrationModuleNamespace = Record<string, unknown>

/** Both builds' exports resolve the same way, so neither is typed against its own build's state. */
function migrateExportOf(module: MigrationModuleNamespace): Migrate {
  const candidate = module.migrateWorktreeIdentity
  if (!isMigrate(candidate)) {
    throw new Error('module does not export migrateWorktreeIdentity')
  }
  return candidate
}

function sessionWithRows(): CrossVersionSession {
  return {
    tabsByWorktree: { [OLD_ID]: [] },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: { worktreeId: OLD_ID, agent: 'claude' } },
    terminalSurfaceTombstonesByPaneKey: { [PANE_KEY]: { worktreeId: OLD_ID, retiredAt: 1 } },
    closedTerminalTabTombstonesByTabId: { tab: { worktreeId: OLD_ID, closedAt: 1 } },
    clientHostedBrowserCloseIntentsByEnvironment: {
      env: [{ worktreeId: OLD_ID, url: 'https://example.test' }]
    }
  }
}

function persistedStateAfterRename(): CrossVersionPersistedState {
  return {
    worktreeMeta: { [OLD_ID]: { createdAt: 1 } },
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    workspaceSession: sessionWithRows(),
    workspaceSessionsByHostId: {},
    mobileClientTabSelectionsByDeviceId: {},
    ui: { showDotfilesByWorktree: {} }
  }
}

/** The `worktreeId` each row kind names after a migration, which is what downgrade turns on. */
function rowsById(state: CrossVersionPersistedState): Record<string, string | undefined> {
  const session = state.workspaceSession
  return {
    sleepingAgentSessionsByPaneKey: session.sleepingAgentSessionsByPaneKey[PANE_KEY]?.worktreeId,
    terminalSurfaceTombstonesByPaneKey:
      session.terminalSurfaceTombstonesByPaneKey[PANE_KEY]?.worktreeId,
    closedTerminalTabTombstonesByTabId: session.closedTerminalTabTombstonesByTabId.tab?.worktreeId,
    clientHostedBrowserCloseIntentsByEnvironment:
      session.clientHostedBrowserCloseIntentsByEnvironment.env?.[0]?.worktreeId
  }
}

let preStackMigrate: Migrate
let stackMigrate: Migrate

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(PRE_STACK_REF)
  const [oldModule, newModule] = await Promise.all([
    importReleaseCheckoutModule(
      checkout,
      'src/main/persistence/tracking-repos/worktree-identity-migration.ts'
    ),
    import('../../../src/main/persistence/tracking-repos/worktree-identity-migration')
  ])
  preStackMigrate = migrateExportOf(oldModule)
  stackMigrate = migrateExportOf(newModule)
}, SUITE_TIMEOUT_MS)

describe('cross-version worktree identity downgrade', () => {
  it('pairs two real builds', () => {
    expect(typeof preStackMigrate).toBe('function')
    expect(typeof stackMigrate).toBe('function')
    // Anti-vacuous-pass oracle: one module resolved twice would make every cell same-version.
    expect(preStackMigrate).not.toBe(stackMigrate)
  })

  it('the pre-stack build repoints two of the four row kinds, and strands two', () => {
    const state = persistedStateAfterRename()
    expect(preStackMigrate(state, OLD_ID, NEW_ID)).toBe(true)
    // Measured, not assumed: an earlier draft of this suite asserted the old build repointed
    // nothing at all, and the probe that produced these four values is what corrected it.
    expect(rowsById(state)).toEqual({
      sleepingAgentSessionsByPaneKey: NEW_ID,
      terminalSurfaceTombstonesByPaneKey: NEW_ID,
      closedTerminalTabTombstonesByTabId: OLD_ID,
      clientHostedBrowserCloseIntentsByEnvironment: OLD_ID
    })
  })

  it('the stack repoints all four', () => {
    const state = persistedStateAfterRename()
    expect(stackMigrate(state, OLD_ID, NEW_ID)).toBe(true)
    expect(rowsById(state)).toEqual({
      sleepingAgentSessionsByPaneKey: NEW_ID,
      terminalSurfaceTombstonesByPaneKey: NEW_ID,
      closedTerminalTabTombstonesByTabId: NEW_ID,
      clientHostedBrowserCloseIntentsByEnvironment: NEW_ID
    })
  })

  it('DOWNGRADE: the old build reads new-build state without loss or throw', () => {
    const state = persistedStateAfterRename()
    stackMigrate(state, OLD_ID, NEW_ID)
    // The rolled-back build renames again over state the new build wrote. Nothing it does not
    // understand may throw, and no row may vanish.
    expect(() => preStackMigrate(state, NEW_ID, THIRD_ID)).not.toThrow()
    expect(rowsById(state)).toEqual({
      sleepingAgentSessionsByPaneKey: THIRD_ID,
      terminalSurfaceTombstonesByPaneKey: THIRD_ID,
      // The two this build cannot repoint stay where the NEW build put them — stale, but present,
      // and no worse than this build's own renames already leave them. That is the #19955 check:
      // new-build state does not break the old build.
      closedTerminalTabTombstonesByTabId: NEW_ID,
      clientHostedBrowserCloseIntentsByEnvironment: NEW_ID
    })
  })

  it('UPGRADE: the stack inherits, and does not resurrect, rows an old build stranded', () => {
    const state = persistedStateAfterRename()
    preStackMigrate(state, OLD_ID, NEW_ID)
    stackMigrate(state, NEW_ID, THIRD_ID)
    expect(rowsById(state)).toEqual({
      sleepingAgentSessionsByPaneKey: THIRD_ID,
      terminalSurfaceTombstonesByPaneKey: THIRD_ID,
      // Still on the id the old build stranded them under: the stack repoints from the id it is
      // renaming, and these never reached it. It fixes new renames, not damage already on disk.
      closedTerminalTabTombstonesByTabId: OLD_ID,
      clientHostedBrowserCloseIntentsByEnvironment: OLD_ID
    })
  })

  // Both builds, because the load-bearing forward-compat guarantee is the CURRENT build's: the
  // stack repoints rows by walking a fixed field list, and a field a later build adds must pass
  // through untouched rather than be swept in by anything name-shaped.
  it.each([
    ['the pre-stack build', (): Migrate => preStackMigrate],
    ['the stack', (): Migrate => stackMigrate]
  ])('%s drops no row shape it does not recognise', (_label, migrateOf) => {
    const state = persistedStateAfterRename()
    state.workspaceSession.someFutureFieldByKey = {
      k: { worktreeId: OLD_ID, fromANewerBuild: true }
    }
    expect(() => migrateOf()(state, OLD_ID, NEW_ID)).not.toThrow()
    expect(state.workspaceSession.someFutureFieldByKey).toEqual({
      k: { worktreeId: OLD_ID, fromANewerBuild: true }
    })
  })
})
