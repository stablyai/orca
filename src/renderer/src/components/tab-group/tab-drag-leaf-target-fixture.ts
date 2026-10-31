import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  A,
  B,
  C,
  P_A,
  P_B,
  SOURCE,
  sourceLayout,
  TARGET,
  targetLayout,
  terminalTab,
  WT
} from '../terminal-pane/terminal-tab-into-pane-fixture'
import type { TabDragItemData } from './tab-drag-data'
import {
  resolveTabDragLeafTarget,
  type LeafTargetState,
  type LeafRect
} from './tab-drag-leaf-target'
import { useAppStore } from '../../store'
import type { TabGroupPanelGeometrySnapshot } from './tab-group-panel-split-target'

export { A, B, C, SOURCE, TARGET, WT }

export const GROUP = 'group-1'
export const SOURCE_UNIFIED = 'unified-source'
export const TARGET_UNIFIED = 'unified-target'

/** One 1000x600 panel at the origin with its 32px strip: body is 568px tall. */
export const PANEL = { left: 0, top: 0, width: 1000, height: 600 }
export const BODY = { left: 0, top: 32, width: 1000, height: 568 }

function unifiedTab(id: string, entityId: string, sortOrder: number): Tab {
  return {
    id,
    entityId,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

/** S (one leaf A) and T (leaves B, C unless `target` says otherwise) share one group; T is shown. */
export function leafTargetState(
  patch: Partial<LeafTargetState> & { target?: TerminalLayoutSnapshot } = {}
): LeafTargetState {
  const { target, ...rest } = patch
  const group: TabGroup = {
    id: GROUP,
    worktreeId: WT,
    activeTabId: TARGET_UNIFIED,
    tabOrder: [SOURCE_UNIFIED, TARGET_UNIFIED]
  }
  const tabs: TerminalTab[] = [terminalTab(SOURCE, P_A), terminalTab(TARGET, P_B)]
  return {
    tabsByWorktree: { [WT]: tabs },
    terminalLayoutsByTabId: { [SOURCE]: sourceLayout(), [TARGET]: target ?? targetLayout() },
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    pendingInitialCwdByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    unverifiedPtyLossTabIds: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingPtyShutdownIds: {},
    groupsByWorktree: { [WT]: [group] },
    unifiedTabsByWorktree: {
      [WT]: [unifiedTab(SOURCE_UNIFIED, SOURCE, 0), unifiedTab(TARGET_UNIFIED, TARGET, 1)]
    },
    ...rest
  }
}

export function singleLeafTargetLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: C },
    activeLeafId: C,
    expandedLeafId: null,
    ptyIdsByLeafId: { [C]: P_B }
  }
}

export function sourceDrag(patch: Partial<TabDragItemData> = {}): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId: GROUP,
    unifiedTabId: SOURCE_UNIFIED,
    visibleTabId: SOURCE,
    tabType: 'terminal',
    label: 'build',
    ...patch
  }
}

export function geometrySnapshot(): TabGroupPanelGeometrySnapshot {
  const panelRect = new DOMRect(PANEL.left, PANEL.top, PANEL.width, PANEL.height)
  const bodyRect = new DOMRect(BODY.left, BODY.top, BODY.width, BODY.height)
  const entry = { groupId: GROUP, panelRect, bodyRect }
  return { entries: [entry], byGroupId: new Map([[GROUP, entry]]) }
}

/** The visible leaf rects of T: one leaf filling the body, or B on the left and C on the right. */
export function leafRectsFor(layout: 'single' | 'split'): LeafRect[] {
  return layout === 'single'
    ? [{ leafId: C, rect: BODY }]
    : [
        { leafId: B, rect: { ...BODY, width: 500 } },
        { leafId: C, rect: { ...BODY, left: 500, width: 500 } }
      ]
}

export function sleepingRecord(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: WT,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

/** The fields of a dnd-kit event that the tab drag code reads: the dragged tab, the pointer and `over`. */
function dragEventFields(
  pointer: { x: number; y: number },
  drag: TabDragItemData,
  overGroupId: string | null
) {
  return {
    active: { data: { current: drag }, rect: { current: { initial: null } } },
    over: overGroupId
      ? { data: { current: { kind: 'pane-body', groupId: overGroupId, worktreeId: WT } } }
      : null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointer.x, clientY: pointer.y }
  }
}

export function dragEndEventAt(
  pointer: { x: number; y: number },
  options: { drag?: TabDragItemData; overGroupId?: string } = {}
): DragEndEvent {
  const fields = dragEventFields(pointer, options.drag ?? sourceDrag(), options.overGroupId ?? null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the drop code reads only active.data, over.data, delta and activatorEvent.
  return fields as unknown as DragEndEvent
}

export function dragMoveEventAt(
  pointer: { x: number; y: number },
  options: { drag?: TabDragItemData } = {}
): DragMoveEvent {
  const fields = dragEventFields(pointer, options.drag ?? sourceDrag(), null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hover code reads only active.data, over.data, delta and activatorEvent.
  return fields as unknown as DragMoveEvent
}

export function dragStartEventAt(
  pointer: { x: number; y: number },
  options: { drag?: TabDragItemData } = {}
): DragStartEvent {
  const fields = dragEventFields(pointer, options.drag ?? sourceDrag(), null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start handler reads only active.data.
  return fields as unknown as DragStartEvent
}

/** The join target the overlay shows with the pointer at `pointer` and the leaves laid out as `layout`. */
export function shownLeafTargetAt(
  pointer: { x: number; y: number },
  layout: 'single' | 'split' = 'split'
): ReturnType<typeof resolveTabDragLeafTarget> {
  return resolveTabDragLeafTarget({
    activeDrag: sourceDrag(),
    pointer,
    worktreeId: WT,
    state: useAppStore.getState(),
    geometry: geometrySnapshot(),
    readLeafRects: () => leafRectsFor(layout)
  })
}
