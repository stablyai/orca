// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SlotProps = { terminalTabId: string; isVisible: boolean; isActive: boolean; dimmed?: boolean }

// The workspace has two splits; group-1 is its focused split.
const { WORKTREE_ID, FOCUSED_SPLIT_TAB_ID, OTHER_SPLIT_TAB_ID, mocks } = vi.hoisted(() => ({
  WORKTREE_ID: 'repo::/grid-member',
  FOCUSED_SPLIT_TAB_ID: 'terminal-1',
  OTHER_SPLIT_TAB_ID: 'terminal-2',
  mocks: {
    slots: new Map<string, { isVisible: boolean; isActive: boolean; dimmed: boolean }>(),
    chatShortcutEnabled: new Array<boolean>()
  }
}))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    tabsByWorktree: {
      [WORKTREE_ID]: [
        { id: FOCUSED_SPLIT_TAB_ID, generation: 0 },
        { id: OTHER_SPLIT_TAB_ID, generation: 0 }
      ]
    },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'unified-1',
          contentType: 'terminal',
          entityId: FOCUSED_SPLIT_TAB_ID,
          groupId: 'group-1'
        },
        {
          id: 'unified-2',
          contentType: 'terminal',
          entityId: OTHER_SPLIT_TAB_ID,
          groupId: 'group-2'
        }
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        { id: 'group-1', activeTabId: 'unified-1' },
        { id: 'group-2', activeTabId: 'unified-2' }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
    focusGroup: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false)
  }))
  return { useAppStore }
})
vi.mock('./TerminalOverlaySlot', () => ({
  TerminalOverlaySlot: (props: SlotProps) => {
    mocks.slots.set(props.terminalTabId, {
      isVisible: props.isVisible,
      isActive: props.isActive,
      dimmed: props.dimmed === true
    })
    return null
  }
}))
vi.mock('./use-terminal-tab-cold-parking', () => ({
  useTerminalTabColdParking: () => new Set<string>()
}))
vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: (_worktreeId: string, enabled: boolean) => {
    mocks.chatShortcutEnabled.push(enabled)
  }
}))
vi.mock('../tab-group/workspace-emptied-reaction', () => ({
  captureWorkspaceEmptiedReaction: vi.fn()
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

let root: Root | undefined
beforeEach(() => {
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.slots.clear()
  mocks.chatShortcutEnabled.length = 0
})

async function renderLayer(isWorktreeFocused?: boolean): Promise<void> {
  await act(async () =>
    root?.render(
      <TerminalPaneOverlayLayer
        worktreeId={WORKTREE_ID}
        worktreePath="/grid-member"
        isWorktreeActive
        isWorktreeFocused={isWorktreeFocused}
      />
    )
  )
}

describe('TerminalPaneOverlayLayer on a workspace grid view', () => {
  it('paints an unfocused grid view member without letting its terminal take focus', async () => {
    await renderLayer(false)

    // Why it matters: an active pane focuses itself on mount, so two active cells fight over keys.
    expect(mocks.slots.get(FOCUSED_SPLIT_TAB_ID)).toMatchObject({
      isVisible: true,
      isActive: false
    })
    expect(mocks.chatShortcutEnabled.at(-1)).toBe(false)
  })

  it('keeps the focused grid view member active', async () => {
    await renderLayer(true)

    expect(mocks.slots.get(FOCUSED_SPLIT_TAB_ID)).toMatchObject({ isVisible: true, isActive: true })
    expect(mocks.chatShortcutEnabled.at(-1)).toBe(true)
  })

  it('treats a visible workspace as focused when no grid view is involved', async () => {
    await renderLayer()

    expect(mocks.slots.get(FOCUSED_SPLIT_TAB_ID)).toMatchObject({ isVisible: true, isActive: true })
  })

  it('keeps an unfocused cell dimmed by its own splits, not dimmed as a whole', async () => {
    await renderLayer(false)

    // Why: watching an unfocused cell is the point of the grid view, so its focused split stays bright.
    expect(mocks.slots.get(FOCUSED_SPLIT_TAB_ID)).toMatchObject({ dimmed: false })
    expect(mocks.slots.get(OTHER_SPLIT_TAB_ID)).toMatchObject({ dimmed: true })
  })

  it('dims the same split whether or not the cell holds focus', async () => {
    await renderLayer(true)

    expect(mocks.slots.get(FOCUSED_SPLIT_TAB_ID)).toMatchObject({ dimmed: false })
    expect(mocks.slots.get(OTHER_SPLIT_TAB_ID)).toMatchObject({ dimmed: true })
  })
})
