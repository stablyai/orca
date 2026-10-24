/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdTerminalMoveKeys, terminalTabMoveKey } from '../terminal-pane/terminal-leaf-move-guard'
import { resolveTabDragLeafTarget, type LeafTargetState } from './tab-drag-leaf-target'
import {
  A,
  B,
  C,
  geometrySnapshot,
  leafRectsFor,
  leafTargetState,
  singleLeafTargetLayout,
  sleepingRecord,
  SOURCE,
  sourceDrag,
  TARGET,
  TARGET_UNIFIED,
  WT
} from './tab-drag-leaf-target-fixture'

// These cover the window-applied join, which exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

// Panel 1000x600, body 568 tall at y=32. Level 1 band: x<200 or x>800, y<145.6 or y>486.4.
// Interior: x 200..800, y 145.6..486.4. A single leaf's central box: x 350..650, y 230.8..401.2.
function resolve(
  pointer: { x: number; y: number } | null,
  options: {
    state?: LeafTargetState
    leaves?: 'single' | 'split'
    drag?: Parameters<typeof sourceDrag>[0]
  } = {}
) {
  const leaves = leafRectsFor(options.leaves ?? 'split')
  return resolveTabDragLeafTarget({
    activeDrag: sourceDrag(options.drag),
    pointer,
    worktreeId: WT,
    state: options.state ?? leafTargetState(),
    geometry: geometrySnapshot(),
    readLeafRects: () => leaves
  })
}

const releases: (() => void)[] = []

afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
})

describe('resolveTabDragLeafTarget', () => {
  describe('a single-leaf target tab: all four edges are reachable', () => {
    const state = () => leafTargetState({ target: singleLeafTargetLayout() })

    it.each([
      ['left', { x: 230, y: 316 }, 'left'],
      ['right', { x: 770, y: 316 }, 'right'],
      ['up', { x: 500, y: 170 }, 'top'],
      ['down', { x: 500, y: 460 }, 'bottom']
    ] as const)('%s edge of the interior joins on side %s', (zone, pointer, side) => {
      const target = resolve(pointer, { state: state(), leaves: 'single' })

      expect(target).toMatchObject({
        groupId: 'group-1',
        targetTabId: TARGET,
        leafId: C,
        zone,
        side,
        refusal: null
      })
    })

    it('draws the overlay on the whole visible leaf', () => {
      const target = resolve({ x: 770, y: 316 }, { state: state(), leaves: 'single' })

      expect(target?.leafRect).toEqual({ left: 0, top: 32, width: 1000, height: 568 })
    })
  })

  it("falls through to today's behaviour in the central box of a leaf", () => {
    expect(resolve({ x: 500, y: 316 }, { leaves: 'single' })).toBeNull()
    expect(resolve({ x: 600, y: 300 })).toBeNull()
  })

  it.each([
    ['left band', { x: 100, y: 316 }],
    ['right band', { x: 900, y: 316 }],
    ['top band', { x: 500, y: 100 }],
    ['bottom band', { x: 500, y: 540 }],
    ['tab strip', { x: 500, y: 10 }],
    ['outside every panel', { x: 1500, y: 316 }]
  ])('does not take the %s: Level 1 keeps it', (_name, pointer) => {
    expect(resolve(pointer)).toBeNull()
  })

  it('picks the leaf under the pointer and clips its zone to the interior', () => {
    expect(resolve({ x: 260, y: 300 })).toMatchObject({ leafId: B, zone: 'left', side: 'left' })
    expect(resolve({ x: 790, y: 300 })).toMatchObject({ leafId: C, zone: 'right', side: 'right' })
    // The seam between B and C is the right edge of B's interior and the left edge of C's.
    expect(resolve({ x: 490, y: 300 })).toMatchObject({ leafId: B, zone: 'right' })
    expect(resolve({ x: 510, y: 300 })).toMatchObject({ leafId: C, zone: 'left' })
  })

  it('clips a leaf taller than the body to the body', () => {
    const target = resolveTabDragLeafTarget({
      activeDrag: sourceDrag(),
      pointer: { x: 770, y: 316 },
      worktreeId: WT,
      state: leafTargetState({ target: singleLeafTargetLayout() }),
      geometry: geometrySnapshot(),
      readLeafRects: () => [{ leafId: C, rect: { left: -50, top: 0, width: 1100, height: 700 } }]
    })

    expect(target?.leafRect).toEqual({ left: 0, top: 32, width: 1000, height: 568 })
  })

  it('ignores a leaf that has no size and a leaf that is not mounted', () => {
    const collapsed = resolveTabDragLeafTarget({
      activeDrag: sourceDrag(),
      pointer: { x: 770, y: 316 },
      worktreeId: WT,
      state: leafTargetState(),
      geometry: geometrySnapshot(),
      readLeafRects: () => [{ leafId: C, rect: { left: 500, top: 32, width: 0, height: 568 } }]
    })
    expect(collapsed).toBeNull()
    expect(
      resolveTabDragLeafTarget({
        activeDrag: sourceDrag(),
        pointer: { x: 770, y: 316 },
        worktreeId: WT,
        state: leafTargetState(),
        geometry: geometrySnapshot(),
        readLeafRects: () => []
      })
    ).toBeNull()
  })

  it('has no pointer, no target', () => {
    expect(resolve(null)).toBeNull()
  })

  describe('the shown tab of the group is the target', () => {
    it('follows a preview that made another tab the shown one', () => {
      const state = leafTargetState()
      const [group] = state.groupsByWorktree[WT] ?? []
      const previewed = leafTargetState({
        groupsByWorktree: { [WT]: [{ ...group!, activeTabId: 'unified-source' }] }
      })

      // The shown tab is the dragged tab itself: its own leaves are not targets.
      expect(resolve({ x: 770, y: 316 }, { state: previewed })).toBeNull()
      expect(resolve({ x: 770, y: 316 }, { state })).toMatchObject({ targetTabId: TARGET })
      expect(TARGET_UNIFIED).toBe(group?.activeTabId)
    })

    it('is not a target when the shown tab is not a terminal', () => {
      const state = leafTargetState()
      const editor = leafTargetState({
        unifiedTabsByWorktree: {
          [WT]: (state.unifiedTabsByWorktree[WT] ?? []).map((tab) =>
            tab.id === TARGET_UNIFIED ? { ...tab, contentType: 'editor' as const } : tab
          )
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state: editor })).toBeNull()
    })
  })

  describe("a source that cannot join keeps today's behaviour (no target, no overlay)", () => {
    it('is not a terminal tab drag', () => {
      expect(resolve({ x: 770, y: 316 }, { drag: { tabType: 'editor' } })).toBeNull()
    })

    it('has several panes', () => {
      const state = leafTargetState()
      const several = leafTargetState({
        terminalLayoutsByTabId: {
          ...state.terminalLayoutsByTabId,
          [SOURCE]: state.terminalLayoutsByTabId[TARGET]!
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state: several })).toBeNull()
    })

    it('is asleep', () => {
      const paneKey = `${SOURCE}:${A}`
      const asleep = leafTargetState({
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingRecord(paneKey, SOURCE) }
      })

      expect(resolve({ x: 770, y: 316 }, { state: asleep })).toBeNull()
    })

    it('has an exit in progress', () => {
      const exiting = leafTargetState({ pendingPtyShutdownIds: { 'pty-a': 1 } })

      expect(resolve({ x: 770, y: 316 }, { state: exiting })).toBeNull()
    })

    it('is asleep, even over a chat-view target', () => {
      const paneKey = `${SOURCE}:${A}`
      const base = leafTargetState()
      const state = leafTargetState({
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingRecord(paneKey, SOURCE) },
        tabsByWorktree: {
          [WT]: (base.tabsByWorktree[WT] ?? []).map((tab) =>
            tab.id === TARGET ? { ...tab, viewMode: 'chat' as const } : tab
          )
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state })).toBeNull()
    })

    it('runs in a remote runtime, so only the host can move it', () => {
      const base = leafTargetState()
      const remote = leafTargetState({
        terminalLayoutsByTabId: {
          ...base.terminalLayoutsByTabId,
          [SOURCE]: {
            ...base.terminalLayoutsByTabId[SOURCE]!,
            ptyIdsByLeafId: { [A]: 'remote:env-1@@terminal-1' }
          }
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state: remote })).toBeNull()
    })

    it('has queued startup work that closing it would drop', () => {
      const queued = leafTargetState({
        pendingInitialCwdByTabId: { [SOURCE]: '/worktree' }
      })

      expect(resolve({ x: 770, y: 316 }, { state: queued })).toBeNull()
    })
  })

  describe('an eligible source over a leaf that cannot take it shows a disabled target', () => {
    it('refuses a chat-view target tab with its reason', () => {
      const state = leafTargetState()
      const chat = leafTargetState({
        tabsByWorktree: {
          [WT]: (state.tabsByWorktree[WT] ?? []).map((tab) =>
            tab.id === TARGET ? { ...tab, viewMode: 'chat' as const } : tab
          )
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state: chat })).toMatchObject({
        leafId: C,
        zone: 'right',
        refusal: 'target_chat'
      })
    })

    it('stays out of the way of a target that runs in a remote runtime', () => {
      const base = leafTargetState()
      const remote = leafTargetState({
        terminalLayoutsByTabId: {
          ...base.terminalLayoutsByTabId,
          [TARGET]: {
            ...base.terminalLayoutsByTabId[TARGET]!,
            ptyIdsByLeafId: { [B]: 'remote:env-1@@terminal-2', [C]: 'pty-c' }
          }
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state: remote })).toBeNull()
    })

    it('refuses while another move already holds the target tab', () => {
      const release = holdTerminalMoveKeys([terminalTabMoveKey(TARGET)])
      if (release) {
        releases.push(release)
      }

      expect(resolve({ x: 770, y: 316 })).toMatchObject({ refusal: 'move_in_flight' })
    })

    it('refuses a leaf the layout does not know', () => {
      const state = leafTargetState({
        target: {
          root: { type: 'leaf', leafId: B },
          activeLeafId: B,
          expandedLeafId: null,
          ptyIdsByLeafId: { [B]: 'pty-b' }
        }
      })

      expect(resolve({ x: 770, y: 316 }, { state, leaves: 'single' })).toMatchObject({
        leafId: C,
        refusal: 'target_pane_missing'
      })
    })
  })
})
