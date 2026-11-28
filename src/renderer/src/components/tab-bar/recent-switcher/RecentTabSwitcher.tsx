import React, { useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '../../../store/index'
import { activateCyclableTab } from '../../../lib/workspace/tabs/ipc-tab-switch'
import { getShortcutPlatform } from '../../../lib/keyboard/shortcut-platform'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import {
  activateFloatingWorkspaceCyclableTab,
  isFloatingWorkspacePanelFocused
} from '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'
import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord
} from '../../../../../shared/keybindings/window-shortcut-policy'
import {
  buildRecentTabSwitcherModel,
  getNextRecentTabSwitcherIndex,
  normalizeCtrlTabOrderMode,
  type RecentTabSwitcherItem
} from './recent-tab-switching'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

const LazyRecentTabSwitcherOverlay = lazyWithRetry(
  () =>
    import('./RecentTabSwitcherOverlay').then((module) => ({
      default: module.RecentTabSwitcherOverlay
    })),
  { reloadKey: 'recent-tab-switcher-overlay' }
)

type SwitcherState = {
  items: RecentTabSwitcherItem[]
  selectedIndex: number
  targetWorktreeId: string
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

export default function RecentTabSwitcher(): React.JSX.Element | null {
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null)
  const switcherRef = useRef<SwitcherState | null>(null)

  const setSwitcherState = useCallback((next: SwitcherState | null): void => {
    switcherRef.current = next
    setSwitcher(next)
  }, [])

  const openOrAdvance = useCallback(
    (direction: 1 | -1): void => {
      const store = useAppStore.getState()
      const current = switcherRef.current
      const targetWorktreeId =
        current?.targetWorktreeId ??
        (isFloatingWorkspacePanelFocused() ? FLOATING_TERMINAL_WORKTREE_ID : store.activeWorktreeId)
      const isFloating = targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID
      if ((!isFloating && store.activeView !== 'terminal') || !targetWorktreeId) {
        return
      }

      const model = buildRecentTabSwitcherModel(
        store,
        targetWorktreeId,
        normalizeCtrlTabOrderMode(store.settings?.ctrlTabOrderMode)
      )
      if (!model) {
        return
      }

      const selectedKey = current?.items[current.selectedIndex]?.key ?? null
      const currentIndex =
        selectedKey == null
          ? model.activeIndex
          : model.items.findIndex((item) => item.key === selectedKey)
      const selectedIndex = getNextRecentTabSwitcherIndex(
        model.items.length,
        currentIndex,
        direction
      )
      setSwitcherState({ items: model.items, selectedIndex, targetWorktreeId })
    },
    [setSwitcherState]
  )

  const commit = useCallback((): void => {
    const current = switcherRef.current
    setSwitcherState(null)
    const selected = current?.items[current.selectedIndex]
    if (!selected) {
      return
    }
    const store = useAppStore.getState()
    if (current.targetWorktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      activateFloatingWorkspaceCyclableTab(store, selected)
    } else {
      activateCyclableTab(store, selected)
    }
  }, [setSwitcherState])

  const cancel = useCallback((): void => {
    setSwitcherState(null)
  }, [setSwitcherState])

  useEffect(() => {
    const unsubscribeKeyDown = window.api.ui.onCtrlTabKeyDown(({ shiftKey }) => {
      openOrAdvance(shiftKey ? -1 : 1)
    })
    const unsubscribeKeyUp = window.api.ui.onCtrlTabKeyUp(commit)
    return () => {
      unsubscribeKeyDown()
      unsubscribeKeyUp()
    }
  }, [commit, openOrAdvance])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useAppStore.getState()
      if (matchesRecentTabSwitcherChord(event, getShortcutPlatform(), store.keybindings)) {
        // Respect configured bindings for renderer-dispatched keys that bypass Electron’s native input path.
        consumeKeyboardEvent(event)
        openOrAdvance(event.shiftKey ? -1 : 1)
        return
      }
      if (!switcherRef.current) {
        return
      }
      if (event.key === 'Escape') {
        consumeKeyboardEvent(event)
        cancel()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!switcherRef.current || !isRecentTabSwitcherCommitRelease(event)) {
        return
      }
      consumeKeyboardEvent(event)
      commit()
    }
    addAppKeyListener('keydown', onKeyDown)
    addAppKeyListener('keyup', onKeyUp)
    window.addEventListener('blur', cancel)
    return () => {
      removeAppKeyListener('keydown', onKeyDown)
      removeAppKeyListener('keyup', onKeyUp)
      window.removeEventListener('blur', cancel)
    }
  }, [cancel, commit, openOrAdvance])

  if (!switcher) {
    return null
  }

  return (
    <React.Suspense fallback={null}>
      <LazyRecentTabSwitcherOverlay items={switcher.items} selectedIndex={switcher.selectedIndex} />
    </React.Suspense>
  )
}
