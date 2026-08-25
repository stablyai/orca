/**
 * OMP tab-title churn repro: an OMP-owned terminal tab's title text oscillates
 * between "OMP" and "Pi" at spinner cadence, committing a fresh store patch on
 * every frame.
 *
 * OMP wraps Pi, so TWO independent writers publish OSC title frames into the
 * same pane, and both are "correct" from their own vantage point:
 *
 *  A) main's synthetic title spinner. `driveSyntheticTitleFromHook` starts a
 *     shared 80ms interval (src/main/index.ts:1947 SPINNER_FRAMES, :1948
 *     SPINNER_INTERVAL_MS) that injects `\x1b]0;<frame> <profile.workingLabel>\x07`
 *     (:2170, :2205). For an OMP-owned pane the profile is `omp`, so every tick
 *     asserts "<spinner> OMP".
 *  B) the OMP process itself, which is Pi underneath and emits Pi's own frames.
 *     "⠋ Pi" passes through untouched, and legacy "π …" frames are collapsed to
 *     a HARDCODED "Pi" by `normalizeTerminalTitle`
 *     (src/shared/agent-title-status.ts:135-144) — that collapse is
 *     identity-blind, so an OMP-owned pane still yields the literal "Pi".
 *
 * `pi` and `omp` share `titleIdentityGroup: 'pi-compatible'`
 * (src/shared/synthetic-agent-title.ts:45-56), so these are the SAME identity as
 * far as ownership is concerned — but neither writer is normalized to the tab's
 * launch owner before it reaches the store.
 *
 * The churn suppressor that normally absorbs spinner noise is defeated here.
 * `isDecorativeAgentTitleFrameChange` keys on `status:textWithoutSpinner`
 * (src/shared/agent-decorative-title-signature.ts:17): "⠋ OMP" -> `working:OMP`,
 * "⠙ Pi" -> `working:Pi`. The signatures differ, so every alternating frame is
 * classified as a MEANINGFUL change and commits — through
 * `applyTerminalTabTitleUpdates`
 * (src/renderer/src/store/slices/terminal-tab-title-batch.ts:183) for `tab.title`
 * (the string `resolveTerminalTabTitle` renders in the tab bar) and through
 * `setRuntimePaneTitle`
 * (src/renderer/src/store/terminals/terminal-tab-presentation.ts:145-172) for the
 * pane slot. At 80ms that is ~12 committed patches per second, per working OMP
 * tab, with a visibly flickering label.
 *
 * The oracle is commit COUNT, not exact text: the status never leaves 'working'
 * across the sequence, so a correctly owner-pinned title settles after the first
 * frame and every later frame is decoration. Both tests drive the REAL store
 * actions over the REAL frame text main emits.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/components/terminal-pane/shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: vi.fn()
}))

// @ts-expect-error -- minimal preload API stub for the slice's IPC writes
globalThis.window = { api: {} }

import { getPiCompatibleSyntheticAgentLabel } from '../../../../shared/pi-compatible-synthetic-title'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import {
  createTestStore,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'

const WT = 'wt-omp'
const TAB_ID = 'tab-omp-1'
const GROUP_ID = 'group-1'
const PANE_ID = 1

// Verbatim from src/main/index.ts:1947.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 20 frames of one OMP turn: main's synthetic "OMP" tick interleaved with the
 * wrapped Pi harness's own frame. Every frame classifies as 'working', so the
 * ONLY thing changing is which of the two pi-compatible identities is showing.
 */
const OMP_TURN_TITLE_FRAMES = Array.from({ length: 20 }, (_, index) => {
  const spinner = SPINNER_FRAMES[index % SPINNER_FRAMES.length]
  return index % 2 === 0 ? `${spinner} OMP` : `${spinner} Pi`
})

function seedOmpTab(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt-omp' })]
    },
    tabsByWorktree: {
      // The user launched OMP into this tab — the identity the title must follow.
      [WT]: [makeTab({ id: TAB_ID, worktreeId: WT, title: 'Terminal 1', launchAgent: 'omp' })]
    },
    unifiedTabsByWorktree: {
      [WT]: [makeUnifiedTab({ id: TAB_ID, worktreeId: WT, groupId: GROUP_ID })]
    },
    activeWorktreeId: WT
  })
}

/** The identity a tab-bar frame reads as: 'OMP', 'Pi', or null when neither. */
function displayedAgentIdentity(tabTitle: string): string | null {
  return getPiCompatibleSyntheticAgentLabel(
    resolveTerminalTabTitle({ title: tabTitle, customTitle: null }, false, 'Terminal 1')
  )
}

describe('OMP-owned tab title across interleaved OMP/Pi spinner frames', () => {
  it('commits at most one tab-title patch for the whole working turn', () => {
    const store = createTestStore()
    seedOmpTab(store)

    // Zustand only notifies when the action returns a fresh patch, so one
    // listener call === one committed store patch.
    let commits = 0
    const seenTitles: string[] = []
    const unsubscribe = store.subscribe((state) => {
      commits += 1
      const title = state.tabsByWorktree[WT]?.[0]?.title
      if (title && title !== seenTitles.at(-1)) {
        seenTitles.push(title)
      }
    })

    for (const frame of OMP_TURN_TITLE_FRAMES) {
      store.getState().updateTabTitle(TAB_ID, frame)
    }
    unsubscribe()

    // One commit takes the tab off its "Terminal 1" default; the remaining 19
    // frames are pure decoration under the OMP owner.
    expect(commits).toBeLessThanOrEqual(1)
    expect(Array.from(new Set(seenTitles.map(displayedAgentIdentity)))).toEqual(['OMP'])
  })

  it('commits at most one runtime pane-title patch for the whole working turn', () => {
    const store = createTestStore()
    seedOmpTab(store)

    let commits = 0
    const unsubscribe = store.subscribe(() => {
      commits += 1
    })

    for (const frame of OMP_TURN_TITLE_FRAMES) {
      store.getState().setRuntimePaneTitle(TAB_ID, PANE_ID, frame)
    }
    unsubscribe()

    expect(commits).toBeLessThanOrEqual(1)
    expect(
      getPiCompatibleSyntheticAgentLabel(
        store.getState().runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID] ?? ''
      )
    ).toBe('OMP')
  })

  // Why: relabeling is for frames naming a DIFFERENT group member. A frame that already names the
  // owner carries its own status wording, so restating bare "OMP" as "OMP ready" would change a
  // tab that never flapped — and the same guard keeps a plain Pi-owned tab byte-identical.
  it.each([
    ['omp', 'OMP'],
    ['pi', 'Pi']
  ] as const)('leaves a %s-owned tab’s own identity frames untouched', (launchAgent, label) => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt-omp' })] },
      tabsByWorktree: {
        [WT]: [makeTab({ id: TAB_ID, worktreeId: WT, title: 'Terminal 1', launchAgent })]
      },
      unifiedTabsByWorktree: {
        [WT]: [makeUnifiedTab({ id: TAB_ID, worktreeId: WT, groupId: GROUP_ID })]
      },
      activeWorktreeId: WT
    })

    for (const frame of [label, `${label} ready`, `⠋ ${label}`]) {
      store.getState().setRuntimePaneTitle(TAB_ID, PANE_ID, frame)
      expect(store.getState().runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID]).toBe(frame)
    }
  })

  // Why: owner-pinning must stay scoped to bare identity frames. A semantic session title carries
  // text no agent profile can reproduce, so relabeling it to "OMP ready" would lose real
  // information — the complaint in #16093, which this fix must not reintroduce.
  it('leaves a semantic session title untouched', () => {
    const store = createTestStore()
    seedOmpTab(store)

    const semanticTitle = 'π - fixing the sidebar - orca'
    store.getState().updateTabTitle(TAB_ID, semanticTitle)
    store.getState().setRuntimePaneTitle(TAB_ID, PANE_ID, semanticTitle)

    expect(store.getState().tabsByWorktree[WT]?.[0]?.title).toBe(semanticTitle)
    expect(store.getState().runtimePaneTitlesByTabId[TAB_ID]?.[PANE_ID]).toBe(semanticTitle)
  })
})
