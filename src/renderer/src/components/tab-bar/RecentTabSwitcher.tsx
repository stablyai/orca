import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, GitCompare, Globe2, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../../store'
import { activateCyclableTab } from '../../hooks/ipc-tab-switch'
import { getShortcutPlatform } from '../../hooks/useShortcutLabel'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  activateFloatingWorkspaceCyclableTab,
  isFloatingWorkspacePanelFocused
} from '@/lib/floating-workspace-terminal-actions'
import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord
} from '../../../../shared/window-shortcut-policy'
import {
  buildRecentTabSwitcherModel,
  getNextRecentTabSwitcherIndex,
  normalizeCtrlTabOrderMode,
  type RecentTabSwitcherItem
} from './recent-tab-switching'
import { translate } from '@/i18n/i18n'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { cn } from '@/lib/utils'

type SwitcherState = {
  items: RecentTabSwitcherItem[]
  selectedIndex: number
  targetWorktreeId: string
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function TabIcon({ item }: { item: RecentTabSwitcherItem }): React.JSX.Element {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (item.type === 'terminal') {
    return <TerminalSquare className={className} />
  }
  if (item.type === 'browser') {
    return <Globe2 className={className} />
  }
  if (
    item.contentType === 'diff' ||
    item.contentType === 'conflict-review' ||
    item.contentType === 'check-details'
  ) {
    return <GitCompare className={className} />
  }
  return <FileText className={className} />
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

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-start justify-center pt-[12vh]">
      <div
        className="w-[min(22.5rem,calc(100vw-3rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
        role="listbox"
        aria-label={translate(
          'auto.components.tab.bar.RecentTabSwitcher.07ad4cd0b7',
          'Switch tabs'
        )}
      >
        <div className="border-b border-border px-2 py-1 text-2xs font-semibold text-muted-foreground">
          {translate('auto.components.tab.bar.RecentTabSwitcher.329638ff6f', 'Switch Tab')}
        </div>
        <div className="max-h-[min(18rem,60vh)] overflow-hidden py-0.5">
          {switcher.items.map((item, index) => {
            const selected = index === switcher.selectedIndex
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={selected}
                className={cn(
                  'flex h-6 items-center gap-1.5 px-2 text-xs',
                  selected ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                <TabIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.isDirty ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
