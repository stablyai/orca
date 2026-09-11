/**
 * Rollback against a real `orca-data.json`, driven through both builds' real `Store`.
 *
 * The migration-pair suite next door measures the re-key function. This one measures the layer
 * underneath it: the actual write path (durable temp + rename, secret substitution, the load
 * path's default spread) writing a real file that the other build then opens. That is the layer
 * PR #19955 lived in, and a mis-sliced segment or a wholesale overwrite is invisible until
 * something reads the bytes back.
 *
 * Three questions, each its own cell:
 *  1. does the old build READ state the new build wrote — no throw, no loss;
 *  2. does the old build WRITE it back in a shape the new build still accepts (the user who
 *     reverts, works for a day, then upgrades again);
 *  3. does either build DELETE state it does not understand — the wholesale-overwrite mechanism.
 *
 * Comparison is whole-session rather than field-by-field, deliberately. A first draft asserted on
 * three hand-picked row maps and both CONTROLS failed, because the store does not round-trip
 * `sleepingAgentSessionsByPaneKey` or `terminalSurfaceTombstonesByPaneKey` in EITHER build. Naming
 * fields meant the suite was measuring the author's guess about the schema; comparing what the two
 * builds each read from one file measures the thing the question is actually about.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(4)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { importReleaseCheckoutModule, materializeReleaseCheckout } = await import(
  './release-checkout'
)

const PRE_STACK_REF = 'v1.4.199'
const SUITE_TIMEOUT_MS = 180_000
const HOST_ID = 'ssh:user@host'
const WORKTREE_ID = 'repo::/worktrees/one'

type Store = {
  setWorkspaceSession: (session: unknown, hostId?: string) => void
  getWorkspaceSession: (hostId?: string) => Record<string, unknown>
  flush: () => void
}
type StoreCtor = new (options: { dataFile: string }) => Store

let StackStore: StoreCtor
let OldStore: StoreCtor

const open: Store[] = []
afterEach(() => {
  for (const store of open.splice(0)) {
    try {
      store.flush()
    } catch {
      // A cell that left a store mid-state must not fail teardown for its neighbours.
    }
  }
})

function openStore(Ctor: StoreCtor, dataFile: string): Store {
  const store = new Ctor({ dataFile })
  open.push(store)
  return store
}

function dataFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'j4-ondisk-')), 'orca-data.json')
}

function session(activeTabId: string): Record<string, unknown> {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    activeTabId,
    tabsByWorktree: { [WORKTREE_ID]: [] },
    terminalLayoutsByTabId: {},
    closedTerminalTabTombstonesByTabId: { tab: { worktreeId: WORKTREE_ID, closedAt: 1 } }
  }
}

/** Both partitions as one comparable value; the SSH one is what #19955 made invisible. */
function bothPartitions(store: Store): Record<string, unknown> {
  return { local: store.getWorkspaceSession(), remote: store.getWorkspaceSession(HOST_ID) }
}

function writeWith(Ctor: StoreCtor, file: string, activeTabId: string): Store {
  const store = openStore(Ctor, file)
  store.setWorkspaceSession(session(activeTabId))
  store.setWorkspaceSession(session(`${activeTabId}-remote`), HOST_ID)
  store.flush()
  return store
}

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(PRE_STACK_REF)
  const [stackModule, oldModule] = await Promise.all([
    import('../../../src/main/persistence/loading-store/store'),
    importReleaseCheckoutModule(checkout, 'src/main/persistence/loading-store/store.ts')
  ])
  StackStore = stackModule.Store as StoreCtor
  OldStore = oldModule.Store as StoreCtor
}, SUITE_TIMEOUT_MS)

describe('cross-version on-disk rollback', () => {
  it('pairs two real builds', () => {
    expect(typeof StackStore).toBe('function')
    expect(typeof OldStore).toBe('function')
    // Anti-vacuous-pass oracle: one module resolved twice would make every cell same-version.
    expect(StackStore).not.toBe(OldStore)
  })

  it('CONTROL: the stack round-trips its own write', () => {
    const file = dataFile()
    writeWith(StackStore, file, 'tab-a')
    const first = openStore(StackStore, file)
    const snapshot = bothPartitions(first)
    first.flush()
    const again = openStore(StackStore, file)
    expect(bothPartitions(again)).toEqual(snapshot)
    expect(snapshot.local).toMatchObject({ activeTabId: 'tab-a' })
  })

  it('CONTROL: the pre-stack build round-trips its own write', () => {
    const file = dataFile()
    writeWith(OldStore, file, 'tab-a')
    const first = openStore(OldStore, file)
    const snapshot = bothPartitions(first)
    first.flush()
    const again = openStore(OldStore, file)
    expect(bothPartitions(again)).toEqual(snapshot)
    expect(snapshot.local).toMatchObject({ activeTabId: 'tab-a' })
  })

  it('Q1 DOWNGRADE: the old build reads everything the stack reads from the same file', () => {
    const file = dataFile()
    writeWith(StackStore, file, 'tab-a')

    const stackView = bothPartitions(openStore(StackStore, file))
    let oldView: Record<string, unknown> | undefined
    expect(() => {
      oldView = bothPartitions(openStore(OldStore, file))
    }).not.toThrow()
    // The whole session, both partitions. Nothing the stack can see may be missing here.
    expect(oldView).toEqual(stackView)
    expect((oldView!.remote as Record<string, unknown>).activeTabId).toBe('tab-a-remote')
  })

  it('Q2 ROLLBACK ROUND TRIP: the old build writes back and the stack still accepts it', () => {
    const file = dataFile()
    writeWith(StackStore, file, 'tab-a')

    // The user reverts and works for a day: the old build loads and saves repeatedly.
    const rolledBack = openStore(OldStore, file)
    rolledBack.setWorkspaceSession(session('tab-edited'))
    rolledBack.flush()

    // Compare reload against reload. An earlier draft compared the old build's IN-MEMORY session
    // against the stack's reloaded one and reddened on the load path's default spread — 10 keys
    // versus 25 — which is not a loss and not a skew.
    const oldReload = bothPartitions(openStore(OldStore, file))
    const stackReload = bothPartitions(openStore(StackStore, file))
    expect(stackReload).toEqual(oldReload)
    expect((stackReload.local as Record<string, unknown>).activeTabId).toBe('tab-edited')
    // The partition the old build never touched must survive its writes.
    expect((stackReload.remote as Record<string, unknown>).activeTabId).toBe('tab-a-remote')
  })

  /**
   * `tabsByWorktree[id] === []` is user intent — the worktree whose last terminal was closed —
   * so an empty array being pruned to absence is not cosmetic. Measured in both builds, because
   * a prune that both do on every save is normal behaviour, not a rollback defect.
   */
  it('an empty tab list is pruned by BOTH builds, so rollback does not cause it', () => {
    const emptyIntent = (activeTabId: string): Record<string, unknown> => ({
      ...session(activeTabId),
      tabsByWorktree: { [WORKTREE_ID]: [] }
    })

    const stackFile = dataFile()
    const stackWriter = openStore(StackStore, stackFile)
    stackWriter.setWorkspaceSession(emptyIntent('tab-a'))
    stackWriter.flush()
    const stackKept = (
      openStore(StackStore, stackFile).getWorkspaceSession().tabsByWorktree as Record<
        string,
        unknown
      >
    )[WORKTREE_ID]

    const oldFile = dataFile()
    const oldWriter = openStore(OldStore, oldFile)
    oldWriter.setWorkspaceSession(emptyIntent('tab-a'))
    oldWriter.flush()
    const oldKept = (
      openStore(OldStore, oldFile).getWorkspaceSession().tabsByWorktree as Record<string, unknown>
    )[WORKTREE_ID]

    // Whatever the answer is, both builds must agree: that is what makes it not a skew.
    expect(stackKept).toEqual(oldKept)
    // Pinned literally so the cell cannot pass by both sides being undefined for different
    // reasons, and so a future build that starts preserving the intent turns this red on purpose.
    expect(stackKept).toBeUndefined()
    writeFileSync(
      '/tmp/j4_emptylist_probe.txt',
      `stackKept=${JSON.stringify(stackKept)} oldKept=${JSON.stringify(oldKept)}\n`
    )
  })

  it('Q3 OVERWRITE: the old build does not delete a top-level key it does not understand', () => {
    const file = dataFile()
    writeWith(StackStore, file, 'tab-a')

    // A key from a hypothetical newer build. This measures the mechanism behind #19955 — whether a
    // load/save cycle republishes wholesale — rather than any field this stack happens to add.
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    onDisk.someFutureTopLevelKey = { fromANewerBuild: true }
    writeFileSync(file, JSON.stringify(onDisk))

    const rolledBack = openStore(OldStore, file)
    rolledBack.setWorkspaceSession(session('tab-edited'))
    rolledBack.flush()

    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(after.someFutureTopLevelKey).toEqual({ fromANewerBuild: true })
  })
})
