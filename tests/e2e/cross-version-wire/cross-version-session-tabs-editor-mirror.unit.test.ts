import { execFileSync } from 'node:child_process'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { WebSessionTabsSyncState } from '../../../src/renderer/src/runtime/web-session-tabs-sync/state'
import type { OpenFile } from '../../../src/renderer/src/store/slices/editor/types/open-file'
import type { AppState } from '../../../src/renderer/src/store/types'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../src/shared/runtime-types'
import type { SalvagedWorkspaceSession } from '../../../src/shared/workspace-session-salvage'
import {
  REPO_ROOT,
  importReleaseCheckoutModule,
  materializeReleaseCheckout
} from './release-checkout'

/**
 * The session-tabs editor-mirror surface, paired across two builds.
 *
 * The fix changes one predicate on the publishing side (`isMobilePublishableOpenFile` now
 * refuses a row marked `mirroredFromRuntimeSession`) and lets that marker survive the
 * persisted-session schema. The frame shape is untouched, so the skew that matters is
 * between two pure functions whose signatures did not move:
 *
 *  - `buildMobileSessionTabSnapshots(state, false)` — what a build publishes;
 *  - `applyWebSessionTabsSnapshot(state, frame, envId, now)` — what a build keeps.
 *
 * Cells pair a NEW host/receiver with an OLD peer taken from a real release checkout and
 * compare each skewed result against the same-version reference, so a pass means "the old
 * build reads the new frame exactly as an old frame" rather than "nothing crashed".
 *
 * The old ref defaults to a pinned pre-fix release; `ORCA_CROSS_VERSION_BASELINE_REF`
 * overrides it for an exact pairing with the PR base. Cells that state what the OLD build
 * does wrong (it echoes a mirror) only run against a commit known to be pre-fix, because a
 * moving baseline's behaviour must not be written down here.
 */
const DEFAULT_PRE_FIX_REF = 'v1.4.204'
const OLD_REF = process.env.ORCA_CROSS_VERSION_BASELINE_REF?.trim() || DEFAULT_PRE_FIX_REF
/** Commits verified by hand to lack the marker check in `isMobilePublishableOpenFile`. */
const KNOWN_PRE_FIX_COMMITS = new Set([
  // v1.4.204
  '4f7baefc4f5c49181d54046763e083a4628662d8',
  // Base of the fix (069701446b)
  '069701446bba5ca479281f5867802ca78d3c1060'
])
// Resolved at collection time: `it.skipIf` reads it before any hook runs.
const OLD_COMMIT = execFileSync('git', ['rev-parse', `${OLD_REF}^{commit}`], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim()
const oldIsKnownPreFix = KNOWN_PRE_FIX_COMMITS.has(OLD_COMMIT)

const SUITE_TIMEOUT_MS = 180_000

const WT = 'repo::/worktree'
const ENV_A = 'env-a-new-host'
const ENV_B = 'env-b-old-peer'
const NOW = 1_700_000_000_000
const FILE_PATH = '/repo/app.ts'

type Publish = (state: AppState, systemPrefersDark: boolean) => RuntimeMobileSessionTabsSnapshot[]
type Apply = (
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number
) => Partial<WebSessionTabsSyncState>

type Build = {
  label: string
  commit: string
  publish: Publish
  apply: Apply
  isMobilePublishableOpenFile: (file: OpenFile) => boolean
  resetFreshness: () => void
  clearPublicationCache: () => void
  parseSession: (raw: unknown) => SalvagedWorkspaceSession
}

type BuildModules = {
  snapshots: Record<string, unknown>
  surfaces: Record<string, unknown>
  graphState: Record<string, unknown>
  snapshotApi: Record<string, unknown>
  trackingLifecycle: Record<string, unknown>
  salvage: Record<string, unknown>
}

const MODULE_PATHS = {
  snapshots: 'src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots.ts',
  surfaces: 'src/renderer/src/runtime/sync-runtime-graph/mobile-session-surfaces.ts',
  graphState: 'src/renderer/src/runtime/sync-runtime-graph/graph-state.ts',
  snapshotApi: 'src/renderer/src/runtime/web-session-tabs-sync/snapshot-api.ts',
  trackingLifecycle: 'src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle.ts',
  salvage: 'src/shared/workspace-session-salvage.ts'
} as const

function requireFunction<T>(module: Record<string, unknown>, name: string, label: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`${label}: ${name} is not exported as a function`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the export was just checked to be a function; its signature is pinned by the shared wire contract this spec drives.
  return value as T
}

function toBuild(label: string, commit: string, modules: BuildModules): Build {
  const graphState = modules.graphState.graphState
  if (
    typeof graphState !== 'object' ||
    graphState === null ||
    !('mobileSessionSnapshotCacheByWorktree' in graphState) ||
    !(graphState.mobileSessionSnapshotCacheByWorktree instanceof Map)
  ) {
    throw new Error(`${label}: graph-state has no mobileSessionSnapshotCacheByWorktree map`)
  }
  const cache = graphState.mobileSessionSnapshotCacheByWorktree
  return {
    label,
    commit,
    publish: requireFunction<Publish>(modules.snapshots, 'buildMobileSessionTabSnapshots', label),
    apply: requireFunction<Apply>(modules.snapshotApi, 'applyWebSessionTabsSnapshot', label),
    isMobilePublishableOpenFile: requireFunction(
      modules.surfaces,
      'isMobilePublishableOpenFile',
      label
    ),
    resetFreshness: requireFunction(
      modules.trackingLifecycle,
      'resetWebSessionTabsSnapshotFreshnessForTests',
      label
    ),
    clearPublicationCache: () => cache.clear(),
    parseSession: requireFunction(modules.salvage, 'parseWorkspaceSessionSalvaging', label)
  }
}

async function loadBuild(ref: string | null): Promise<Build> {
  if (ref === null) {
    const [snapshots, surfaces, graphState, snapshotApi, trackingLifecycle, salvage] =
      await Promise.all([
        import('../../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-snapshots'),
        import('../../../src/renderer/src/runtime/sync-runtime-graph/mobile-session-surfaces'),
        import('../../../src/renderer/src/runtime/sync-runtime-graph/graph-state'),
        import('../../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'),
        import('../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle'),
        import('../../../src/shared/workspace-session-salvage')
      ])
    return toBuild('stack', 'HEAD', {
      snapshots,
      surfaces,
      graphState,
      snapshotApi,
      trackingLifecycle,
      salvage
    })
  }
  const checkout = await materializeReleaseCheckout(ref)
  const [snapshots, surfaces, graphState, snapshotApi, trackingLifecycle, salvage] =
    await Promise.all([
      importReleaseCheckoutModule(checkout, MODULE_PATHS.snapshots),
      importReleaseCheckoutModule(checkout, MODULE_PATHS.surfaces),
      importReleaseCheckoutModule(checkout, MODULE_PATHS.graphState),
      importReleaseCheckoutModule(checkout, MODULE_PATHS.snapshotApi),
      importReleaseCheckoutModule(checkout, MODULE_PATHS.trackingLifecycle),
      importReleaseCheckoutModule(checkout, MODULE_PATHS.salvage)
    ])
  return toBuild(ref, checkout.commit, {
    snapshots,
    surfaces,
    graphState,
    snapshotApi,
    trackingLifecycle,
    salvage
  })
}

// Local copies of the sync/publication harness shapes: the checkout's harness imports the
// sync index, which drags the zustand hook in, so neither build's harness is imported.
function makeSyncState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function toPublicationState(state: Partial<AppState>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only the tab/editor/agent slices supplied here, the same subset the in-repo publication harness fabricates.
  return {
    editorDrafts: {},
    runtimePaneTitlesByTabId: {},
    ...state
  } as AppState
}

function publishWorktree(build: Build, state: Partial<AppState>): RuntimeMobileSessionTabsSnapshot {
  const snapshot = build
    .publish(toPublicationState(state), false)
    .find((candidate) => candidate.worktree === WT)
  if (!snapshot) {
    throw new Error(`${build.label}: published no snapshot for ${WT}`)
  }
  return snapshot
}

function applyFrame(
  build: Build,
  state: WebSessionTabsSyncState,
  frame: RuntimeMobileSessionTabsSnapshot,
  environmentId: string,
  now: number
): WebSessionTabsSyncState {
  return { ...state, ...build.apply(state, toClientFrame(frame), environmentId, now) }
}

/** Only terminal tabs differ on the wire (the host attaches a handle); these frames carry none. */
function toClientFrame(frame: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionTabsResult {
  const tabs = frame.tabs.map((tab) => {
    if (tab.type === 'terminal') {
      throw new Error(`unexpected terminal tab ${tab.id} in an editor mirror frame`)
    }
    return tab
  })
  return { ...frame, tabs }
}

/** Frame content without the per-build epoch/version, which differ by construction. */
function frameContent(frame: RuntimeMobileSessionTabsSnapshot): Record<string, unknown> {
  const { publicationEpoch: _epoch, snapshotVersion: _version, ...content } = frame
  return content
}

function worktreeFiles(state: WebSessionTabsSyncState): OpenFile[] {
  return state.openFiles.filter((file) => file.worktreeId === WT)
}

function editorTabs(state: WebSessionTabsSyncState) {
  return (state.unifiedTabsByWorktree[WT] ?? []).filter((tab) => tab.contentType === 'editor')
}

function fileTabs(frame: RuntimeMobileSessionTabsSnapshot): RuntimeMobileSessionFileTab[] {
  return frame.tabs.filter((tab): tab is RuntimeMobileSessionFileTab => tab.type === 'file')
}

const localFile: OpenFile = {
  id: FILE_PATH,
  filePath: FILE_PATH,
  relativePath: 'app.ts',
  worktreeId: WT,
  language: 'typescript',
  mode: 'edit',
  isDirty: false
}

/** A NEW host holding one genuinely local file in its tab strip. */
function hostOpenState(): WebSessionTabsSyncState {
  return makeSyncState({
    openFiles: [localFile],
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'a-own-tab',
          entityId: localFile.id,
          groupId: 'local-group',
          worktreeId: WT,
          contentType: 'editor',
          label: 'app.ts',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW,
          isPreview: false,
          isPinned: false
        }
      ]
    }
  })
}

/** The same host after closing that file; the worktree stays listed with nothing open. */
function hostClosedState(): WebSessionTabsSyncState {
  return makeSyncState({ openFiles: [], unifiedTabsByWorktree: { [WT]: [] } })
}

/** A peer's state after its user closed the mirrored tab, so its next frame omits it. */
function peerClosedMirror(state: WebSessionTabsSyncState): WebSessionTabsSyncState {
  return {
    ...state,
    openFiles: state.openFiles.filter((file) => file.worktreeId !== WT),
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [WT]: [] }
  }
}

function mirroredRow(): OpenFile {
  return { ...localFile, runtimeEnvironmentId: ENV_A, mirroredFromRuntimeSession: true }
}

let old: Build
let stack: Build

beforeAll(async () => {
  ;[old, stack] = await Promise.all([loadBuild(OLD_REF), loadBuild(null)])
  console.info(
    `[cross-version editor mirror] old=${old.label}@${old.commit} knownPreFix=${oldIsKnownPreFix} new=${stack.label}`
  )
}, SUITE_TIMEOUT_MS)

beforeEach(() => {
  for (const build of [old, stack]) {
    build.resetFreshness()
    build.clearPublicationCache()
  }
})

describe('cross-version session-tabs editor mirror', () => {
  it('pairs the stack against a real old release', () => {
    expect(old.label).toBe(OLD_REF)
    expect(old.commit).toBe(OLD_COMMIT)
    // The anti-vacuous-pass oracle: two builds that resolved to one module would make
    // every skew cell below a same-version run wearing a skew label.
    expect(old.publish).not.toBe(stack.publish)
    expect(old.apply).not.toBe(stack.apply)
    expect(old.isMobilePublishableOpenFile).not.toBe(stack.isMobilePublishableOpenFile)
    // Both builds still publish a genuinely local file.
    expect(old.isMobilePublishableOpenFile(localFile)).toBe(true)
    expect(stack.isMobilePublishableOpenFile(localFile)).toBe(true)
    // The fix under test: the new predicate refuses a received row.
    expect(stack.isMobilePublishableOpenFile(mirroredRow())).toBe(false)
  })

  it.skipIf(!oldIsKnownPreFix)(
    'the pinned pre-fix release still treats a received row as its own publication',
    () => {
      // Load-bearing for reading the echo cells below: they mean "this release echoes",
      // not "the predicate happened to agree". Safe only against a known pre-fix commit.
      expect(old.isMobilePublishableOpenFile(mirroredRow())).toBe(true)
    }
  )

  it('case 1: new host -> old client mirrors, then reads omission as close (Rule 3)', () => {
    const openFrame = publishWorktree(stack, hostOpenState())
    expect(fileTabs(openFrame)).toMatchObject([{ filePath: FILE_PATH }])

    const oldB1 = applyFrame(old, makeSyncState(), openFrame, ENV_A, NOW)
    expect(worktreeFiles(oldB1)).toMatchObject([
      {
        filePath: FILE_PATH,
        worktreeId: WT,
        runtimeEnvironmentId: ENV_A,
        mirroredFromRuntimeSession: true
      }
    ])
    expect(editorTabs(oldB1)).toMatchObject([{ id: openFrame.tabs[0]?.id }])
    console.info(
      '[cross-version editor mirror] case 1 old mirror row',
      JSON.stringify({ hostTabId: openFrame.tabs[0]?.id, rowId: worktreeFiles(oldB1)[0]?.id })
    )

    // Host closes: the worktree stays published with no tabs (retained empty snapshot).
    const closedFrame = publishWorktree(stack, hostClosedState())
    expect(closedFrame.tabs).toEqual([])
    expect(closedFrame.snapshotVersion).toBeGreaterThan(openFrame.snapshotVersion)

    const oldB2 = applyFrame(old, oldB1, closedFrame, ENV_A, NOW + 1)
    expect(worktreeFiles(oldB2)).toEqual([])
    expect(editorTabs(oldB2)).toEqual([])

    // Same-version reference: an old host publishing the same two states to an old client.
    old.clearPublicationCache()
    const refOpen = publishWorktree(old, hostOpenState())
    const refClosed = publishWorktree(old, hostClosedState())
    expect(frameContent(openFrame)).toEqual(frameContent(refOpen))
    expect(frameContent(closedFrame)).toEqual(frameContent(refClosed))
    old.resetFreshness()
    const refB1 = applyFrame(old, makeSyncState(), refOpen, ENV_A, NOW)
    const refB2 = applyFrame(old, refB1, refClosed, ENV_A, NOW + 1)
    expect(worktreeFiles(oldB1)).toEqual(worktreeFiles(refB1))
    expect(editorTabs(oldB1)).toEqual(editorTabs(refB1))
    expect(worktreeFiles(oldB2)).toEqual(worktreeFiles(refB2))
    expect(editorTabs(oldB2)).toEqual(editorTabs(refB2))
  })

  it.skipIf(!oldIsKnownPreFix)(
    'case 2: an old peer echoes the mirror; a new receiver does not bounce it back',
    () => {
      const openFrame = publishWorktree(stack, hostOpenState())
      const oldB = applyFrame(old, makeSyncState(), openFrame, ENV_A, NOW)

      // The pre-fix defect, pinned: the old build republishes what it just received.
      const echoFrame = publishWorktree(old, oldB)
      expect(fileTabs(echoFrame)).toMatchObject([{ filePath: FILE_PATH, relativePath: 'app.ts' }])

      // A new receiver takes the echo as a mirror of the old peer...
      const newC = applyFrame(stack, makeSyncState(), echoFrame, ENV_B, NOW + 1)
      expect(worktreeFiles(newC)).toMatchObject([
        { filePath: FILE_PATH, runtimeEnvironmentId: ENV_B, mirroredFromRuntimeSession: true }
      ])
      // ...and publishes nothing for it, which is where the loop stops.
      const newCFrame = publishWorktree(stack, newC)
      expect(newCFrame.tabs).toEqual([])

      // New/new reference: a new peer receiving the same host frame publishes the same nothing.
      stack.resetFreshness()
      const newB = applyFrame(stack, makeSyncState(), openFrame, ENV_A, NOW)
      const newBFrame = publishWorktree(stack, newB)
      expect(newBFrame.tabs).toEqual([])
      expect(frameContent(newCFrame)).toEqual(frameContent(newBFrame))
    }
  )

  it.skipIf(!oldIsKnownPreFix)(
    'control: an old receiver holding the same echo bounces it back (the pre-fix loop)',
    () => {
      const openFrame = publishWorktree(stack, hostOpenState())
      const oldB = applyFrame(old, makeSyncState(), openFrame, ENV_A, NOW)
      const echoFrame = publishWorktree(old, oldB)
      const oldC = applyFrame(old, makeSyncState(), echoFrame, ENV_B, NOW + 1)
      expect(worktreeFiles(oldC)).toMatchObject([
        { filePath: FILE_PATH, runtimeEnvironmentId: ENV_B, mirroredFromRuntimeSession: true }
      ])
      // Same receiver state as case 2, opposite publication: proves the oracle reads the
      // build, not the input, and pins what the fix removes.
      expect(fileTabs(publishWorktree(old, oldC))).toMatchObject([{ filePath: FILE_PATH }])
    }
  )

  it.skipIf(!oldIsKnownPreFix)(
    'case 3: characterizes the F3 collision with a real old publisher echoing a local file',
    () => {
      const a0 = hostOpenState()
      const openFrame = publishWorktree(stack, a0)
      const oldB = applyFrame(old, makeSyncState(), openFrame, ENV_A, NOW)
      const echoFrame = publishWorktree(old, oldB)
      const echoTabId = fileTabs(echoFrame)[0]?.id
      expect(echoTabId).toBeDefined()
      console.info(
        '[cross-version editor mirror] case 3 echo',
        JSON.stringify({
          hostTabId: openFrame.tabs[0]?.id,
          echoTabId,
          oldRowId: worktreeFiles(oldB)[0]?.id
        })
      )

      // The echo lands on the host that owns the file: two rows share the bare id, and the
      // host's own unified tab is replaced by the peer's tab id.
      const a1 = applyFrame(stack, a0, echoFrame, ENV_B, NOW + 1)
      expect(worktreeFiles(a1)).toHaveLength(2)
      expect(a1.openFiles[0]).toBe(localFile)
      expect(a1.openFiles[1]).toMatchObject({
        id: localFile.id,
        runtimeEnvironmentId: ENV_B,
        mirroredFromRuntimeSession: true
      })
      expect(editorTabs(a1)).toMatchObject([{ id: echoTabId, entityId: localFile.id }])
      // First-wins indexing republishes the local row under the peer's tab id; characterized
      // here, deduped on write by #21124 rather than by this fix.
      expect(fileTabs(publishWorktree(stack, a1))).toMatchObject([
        { id: echoTabId, filePath: FILE_PATH }
      ])

      // The old peer's user closes the mirror; its next real frame omits it.
      const omitFrame = publishWorktree(old, peerClosedMirror(oldB))
      expect(omitFrame.tabs).toEqual([])
      expect(omitFrame.snapshotVersion).toBeGreaterThan(echoFrame.snapshotVersion)
      const a2 = applyFrame(stack, a1, omitFrame, ENV_B, NOW + 2)
      expect(worktreeFiles(a2)).toEqual([localFile])
      expect(a2.unifiedTabsByWorktree[WT]).toBeUndefined()
    }
  )

  it.skipIf(!oldIsKnownPreFix)(
    'case 4: five rounds of old-echo/new-apply ping-pong stay bounded',
    () => {
      let a = hostOpenState()
      let b = makeSyncState()
      let now = NOW
      const hostFrames: Record<string, unknown>[] = []
      const peerFrames: Record<string, unknown>[] = []
      const counts: { round: number; a: number; b: number }[] = []
      for (let round = 1; round <= 5; round++) {
        const hostFrame = publishWorktree(stack, a)
        hostFrames.push(frameContent(hostFrame))
        b = applyFrame(old, b, hostFrame, ENV_A, now++)
        const peerFrame = publishWorktree(old, b)
        peerFrames.push(frameContent(peerFrame))
        a = applyFrame(stack, a, peerFrame, ENV_B, now++)
        counts.push({ round, a: worktreeFiles(a).length, b: worktreeFiles(b).length })
      }
      console.info('[cross-version editor mirror] ping-pong counts', JSON.stringify(counts))
      for (const count of counts) {
        expect(count.a).toBeLessThanOrEqual(2)
        expect(count.b).toBeLessThanOrEqual(1)
      }
      // The old peer echoes exactly one tab every round: no mirror-of-mirror growth.
      for (const frame of peerFrames) {
        expect(frame).toEqual(peerFrames[0])
      }
      // The host's frame settles after the first echo relabels its tab (F3) and stays put.
      for (const frame of hostFrames.slice(1)) {
        expect(frame).toEqual(hostFrames[1])
      }
      expect(worktreeFiles(a)[0]).toBe(localFile)
    }
  )

  it('case 5: an old reader strips the persisted marker; the new reader keeps it', () => {
    const wt = 'wt'
    const plain = {
      filePath: FILE_PATH,
      relativePath: 'app.ts',
      worktreeId: wt,
      language: 'typescript',
      runtimeEnvironmentId: 'peer'
    }
    const marked = { ...plain, mirroredFromRuntimeSession: true }
    const raw = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [marked, { ...plain, mirroredFromRuntimeSession: false }, plain]
      }
    }

    const oldParsed = old.parseSession(raw)
    if (!oldParsed.ok) {
      throw new Error(oldParsed.error)
    }
    // Downgrade on the same profile: every row survives, but none carries the marker, so an
    // old reader would hydrate the mirror as its own file (the U3 caveat, characterized).
    expect(oldParsed.droppedCount).toBe(0)
    expect(oldParsed.value.openFilesByWorktree?.[wt]).toHaveLength(3)
    for (const row of oldParsed.value.openFilesByWorktree?.[wt] ?? []) {
      expect(row).not.toHaveProperty('mirroredFromRuntimeSession')
    }

    const newParsed = stack.parseSession(raw)
    if (!newParsed.ok) {
      throw new Error(newParsed.error)
    }
    expect(newParsed.value.openFilesByWorktree?.[wt]).toEqual([marked, plain])
    expect(newParsed.droppedCount).toBe(1)
    expect(newParsed.droppedPaths).toEqual([`openFilesByWorktree.${wt}.1`])
  })
})
