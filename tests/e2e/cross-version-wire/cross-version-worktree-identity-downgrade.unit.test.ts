import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Pin the pre-change reader: renamed session rows written by a new build must survive rollback and further renames.
const PRE_STACK_REF = 'v1.4.199'
const SUITE_TIMEOUT_MS = 180_000

const OLD_ID = 'repo::/worktrees/before'
const NEW_ID = 'repo::/worktrees/after'
const THIRD_ID = 'repo::/worktrees/third'
const PANE_KEY = 'pane-1'

// Keep the cross-build blob independent of either build’s WorkspaceSessionState type.
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

type MigrationModuleNamespace = Record<string, unknown>

// Validate both builds through the same structural interface.
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
    // Require distinct implementations so every skew cannot silently run the same build.
    expect(preStackMigrate).not.toBe(stackMigrate)
  })

  it('the pre-stack build repoints two of the four row kinds, and strands two', () => {
    const state = persistedStateAfterRename()
    expect(preStackMigrate(state, OLD_ID, NEW_ID)).toBe(true)
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
    // The rolled-back build must preserve rows it does not understand.
    expect(() => preStackMigrate(state, NEW_ID, THIRD_ID)).not.toThrow()
    expect(rowsById(state)).toEqual({
      sleepingAgentSessionsByPaneKey: THIRD_ID,
      terminalSurfaceTombstonesByPaneKey: THIRD_ID,
      // Old readers retain these new-build ids without repointing; downgrade must preserve them (#19955).
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
      // These rows never reached the renamed id; new renames cannot repair ids already stranded on disk.
      closedTerminalTabTombstonesByTabId: OLD_ID,
      clientHostedBrowserCloseIntentsByEnvironment: OLD_ID
    })
  })

  // Check both builds preserve future fields outside the fixed migration field list.
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
