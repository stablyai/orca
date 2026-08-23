/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import { useAppStore } from '../../store'
import { commitTabDragDrop } from './tab-drag-drop-commit'
import type { TabDragItemData } from './tab-drag-data'

const { captureSeed } = vi.hoisted(() => ({ captureSeed: vi.fn() }))

vi.mock('../terminal-pane/terminal-tab-window-transfer', () => ({
  captureTerminalWindowTransferSeed: captureSeed
}))

const WT = 'wt-commit'
const seed = { tabId: 'terminal-1' } as TerminalWindowTransferSeed

function dragData(tabType: TabDragItemData['tabType'] = 'terminal'): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId: 'group-1',
    unifiedTabId: 'terminal-1',
    visibleTabId: 'terminal-1',
    tabType,
    label: 'Terminal'
  }
}

function event(activeData: unknown, pointer: { x: number; y: number }, over: unknown = null) {
  return {
    active: {
      data: { current: activeData },
      rect: { current: { initial: null, translated: null } }
    },
    over,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointer.x, clientY: pointer.y }
  } as unknown as Parameters<typeof commitTabDragDrop>[0]['event']
}

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, top: 0, bottom: 400, width, height: 400 } as DOMRect
}

function runCommit(args: {
  activeData?: unknown
  pointer?: { x: number; y: number }
  over?: unknown
  geometry?: Parameters<typeof commitTabDragDrop>[0]['dragGeometryRef']['current']
  detach?: ReturnType<typeof vi.fn>
}) {
  const finishDrag = vi.fn()
  const dropUnifiedTab = vi.fn(() => true)
  const detach = args.detach ?? vi.fn().mockResolvedValue({ ok: true, targetWindowId: 2 })
  commitTabDragDrop({
    event: event(
      args.activeData ?? dragData(),
      args.pointer ?? { x: window.innerWidth + 1, y: 100 },
      args.over
    ),
    worktreeId: WT,
    dragGeometryRef: { current: args.geometry ?? null },
    dropUnifiedTab: dropUnifiedTab as never,
    reorderUnifiedTabs: vi.fn() as never,
    detachTerminalWindow: detach as never,
    finishDrag
  })
  return { detach, dropUnifiedTab, finishDrag }
}

beforeEach(() => {
  captureSeed.mockReset()
  captureSeed.mockReturnValue({ ok: true, seed })
  useAppStore.setState({
    groupsByWorktree: {
      [WT]: [
        {
          id: 'group-1',
          worktreeId: WT,
          activeTabId: 'terminal-1',
          tabOrder: ['terminal-1', 'terminal-2']
        },
        { id: 'group-2', worktreeId: WT, activeTabId: 'terminal-3', tabOrder: ['terminal-3'] }
      ]
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      }
    }
  })
})

describe('commitTabDragDrop terminal window detach', () => {
  it.each([
    ['unavailable', () => Promise.resolve({ ok: false, error: 'unavailable' })],
    ['rejected', () => Promise.reject(new Error('detach failed'))]
  ])('restores activation when detach is %s', async (_label, makeOutcome) => {
    const outcome = makeOutcome()
    const result = runCommit({ detach: vi.fn(() => outcome) })

    await outcome.catch(() => undefined)
    await Promise.resolve()

    expect(result.finishDrag).toHaveBeenCalledOnce()
    expect(result.finishDrag).toHaveBeenCalledWith(true)
  })

  it('finishes once without restoring after a successful detach', async () => {
    const result = runCommit({})

    await Promise.resolve()

    expect(result.detach).toHaveBeenCalledOnce()
    expect(result.detach).toHaveBeenCalledWith(seed)
    expect(result.finishDrag).toHaveBeenCalledOnce()
    expect(result.finishDrag).toHaveBeenCalledWith(false)
  })

  it.each([
    ['inside viewport', dragData(), { x: 20, y: 20 }],
    ['non-terminal', dragData('editor'), { x: window.innerWidth + 1, y: 20 }],
    ['foreign drag', { ...dragData(), worktreeId: 'foreign' }, { x: window.innerWidth + 1, y: 20 }]
  ])('does not detach an %s drop', (_label, activeData, pointer) => {
    const result = runCommit({ activeData, pointer })

    expect(result.detach).not.toHaveBeenCalled()
    expect(result.finishDrag).toHaveBeenCalledWith(true)
  })

  it('restores without IPC when seed capture rejects the terminal', () => {
    captureSeed.mockReturnValue({ ok: false, error: 'terminal_pty_mismatch' })

    const result = runCommit({})

    expect(result.detach).not.toHaveBeenCalled()
    expect(result.finishDrag).toHaveBeenCalledWith(true)
  })

  it('commits a geometry split before considering outside detach', () => {
    const panelRect = rect(window.innerWidth, 400)
    const bodyRect = { ...panelRect, top: 32, height: 368 } as DOMRect
    const geometry = {
      entries: [{ groupId: 'group-2', panelRect, bodyRect }],
      byGroupId: new Map([['group-2', { groupId: 'group-2', panelRect, bodyRect }]])
    }

    const result = runCommit({
      pointer: { x: window.innerWidth + 1, y: 200 },
      geometry
    })

    expect(result.dropUnifiedTab).toHaveBeenCalledWith('terminal-1', {
      groupId: 'group-2',
      splitDirection: 'left'
    })
    expect(result.detach).not.toHaveBeenCalled()
  })
})
