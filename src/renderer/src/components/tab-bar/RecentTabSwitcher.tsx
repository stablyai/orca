import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, GitCompare, Globe2, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../../store'
import { activateCyclableTab } from '../../hooks/ipc-tab-switch'
import { getShortcutPlatform } from '../../hooks/useShortcutLabel'
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
import { addEventListenerOnAllWindows } from '@/lib/aux-pane-window-registry'
import {
  auxiliaryTerminalShortcutTarget,
  resolveTerminalShortcutTarget,
  type TerminalShortcutTarget
} from '../terminal/aux-pane-shortcut-target'
import { isNode } from '@/lib/cross-realm-dom-predicates'

type SwitcherState = {
  items: RecentTabSwitcherItem[]
  selectedIndex: number
  portalContainer: HTMLElement
  target: TerminalShortcutTarget | null
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function TabIcon({ item }: { item: RecentTabSwitcherItem }): React.JSX.Element {
  const className = 'size-4 shrink-0 text-muted-foreground'
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
    (
      direction: 1 | -1,
      target: TerminalShortcutTarget | null = null,
      portalContainer: HTMLElement = document.body
    ): void => {
      const store = useAppStore.getState()
      const worktreeId = target?.worktreeId ?? store.activeWorktreeId
      if ((!target && store.activeView !== 'terminal') || !worktreeId) {
        return
      }

      const model = buildRecentTabSwitcherModel(
        store,
        worktreeId,
        normalizeCtrlTabOrderMode(store.settings?.ctrlTabOrderMode),
        target?.groupId
      )
      if (!model) {
        return
      }

      const current = switcherRef.current
      const sameTarget =
        current?.target?.worktreeId === target?.worktreeId &&
        current?.target?.groupId === target?.groupId
      const selectedKey = sameTarget ? (current?.items[current.selectedIndex]?.key ?? null) : null
      const currentIndex =
        selectedKey == null
          ? model.activeIndex
          : model.items.findIndex((item) => item.key === selectedKey)
      const selectedIndex = getNextRecentTabSwitcherIndex(
        model.items.length,
        currentIndex,
        direction
      )
      setSwitcherState({ items: model.items, selectedIndex, portalContainer, target })
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
    activateCyclableTab(useAppStore.getState(), selected)
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
        // Why: Electron's native before-input-event path is authoritative, but
        // CDP/test-dispatched keys can reach the renderer directly. Respect the
        // keybinding registry here too so tests do not bypass user customization.
        consumeKeyboardEvent(event)
        const target = auxiliaryTerminalShortcutTarget(
          resolveTerminalShortcutTarget(event.target, store)
        )
        const portalContainer = isNode(event.target)
          ? (event.target.ownerDocument?.body ?? document.body)
          : document.body
        openOrAdvance(event.shiftKey ? -1 : 1, target, portalContainer)
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
    const removeListeners = [
      addEventListenerOnAllWindows('keydown', onKeyDown, { capture: true }),
      addEventListenerOnAllWindows('keyup', onKeyUp, { capture: true }),
      addEventListenerOnAllWindows('blur', cancel)
    ]
    return () => {
      for (const removeListener of removeListeners) {
        removeListener()
      }
    }
  }, [cancel, commit, openOrAdvance])

  if (!switcher) {
    return null
  }

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-start justify-center pt-[12vh]">
      <div
        className="w-[min(520px,calc(100vw-48px))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
        role="listbox"
        aria-label={translate(
          'auto.components.tab.bar.RecentTabSwitcher.07ad4cd0b7',
          'Switch tabs'
        )}
      >
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">
          {translate('auto.components.tab.bar.RecentTabSwitcher.329638ff6f', 'Switch Tab')}
        </div>
        <div className="max-h-[min(360px,60vh)] overflow-hidden py-1">
          {switcher.items.map((item, index) => {
            const selected = index === switcher.selectedIndex
            return (
              <div
                key={item.key}
                role="option"
                aria-selected={selected}
                className={`flex h-8 items-center gap-2 px-3 text-sm ${
                  selected ? 'bg-accent text-accent-foreground' : 'text-foreground'
                }`}
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
    switcher.portalContainer
  )
}
