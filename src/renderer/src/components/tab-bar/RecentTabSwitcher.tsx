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
import {
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  queueBrowserFocusRequest
} from '../browser-pane/browser-focus'
import { translate } from '@/i18n/i18n'

type SwitcherState = {
  items: RecentTabSwitcherItem[]
  selectedIndex: number
}

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

// Why: focus requests are keyed by browser *page* id (what BrowserPane mounts),
// while switcher items and activeBrowserTabId carry the browser *tab* id.
function resolveActiveBrowserPageId(
  state: ReturnType<typeof useAppStore.getState>,
  browserTabId: string
): string | null {
  for (const tabs of Object.values(state.browserTabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === browserTabId)
    if (tab) {
      return tab.activePageId ?? null
    }
  }
  return null
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
  // Why: set only when the gesture started inside a browser guest, so commit/
  // cancel know to hand focus back to a webview instead of leaving it on body.
  const guestSourcePageIdRef = useRef<string | null>(null)

  const setSwitcherState = useCallback((next: SwitcherState | null): void => {
    switcherRef.current = next
    setSwitcher(next)
  }, [])

  const requestGuestPageFocus = useCallback((pageId: string): void => {
    const detail = { pageId, target: 'webview' as const }
    queueBrowserFocusRequest(detail)
    window.dispatchEvent(new CustomEvent(ORCA_BROWSER_FOCUS_REQUEST_EVENT, { detail }))
  }, [])

  const releaseGuestFocusForHeldGesture = useCallback((): void => {
    if (!switcherRef.current) {
      return
    }
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || active.tagName !== 'WEBVIEW') {
      return
    }
    const store = useAppStore.getState()
    guestSourcePageIdRef.current =
      store.activeTabType === 'browser' && store.activeBrowserTabId
        ? resolveActiveBrowserPageId(store, store.activeBrowserTabId)
        : null
    // Why: main preventDefault-ed the guest's Ctrl+Tab keydown, and Chromium
    // then suppresses every guest keyup until the next keydown — the
    // modifier-release commit can never arrive over IPC (#9937). Move DOM focus
    // out of the webview so the rest of the held gesture (advance, release,
    // Escape) flows through this window's key handlers instead.
    active.blur()
  }, [])

  const openOrAdvance = useCallback(
    (direction: 1 | -1): void => {
      const store = useAppStore.getState()
      if (store.activeView !== 'terminal' || !store.activeWorktreeId) {
        return
      }

      const model = buildRecentTabSwitcherModel(
        store,
        store.activeWorktreeId,
        normalizeCtrlTabOrderMode(store.settings?.ctrlTabOrderMode)
      )
      if (!model) {
        return
      }

      const current = switcherRef.current
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
      setSwitcherState({ items: model.items, selectedIndex })
    },
    [setSwitcherState]
  )

  const commit = useCallback((): void => {
    const current = switcherRef.current
    setSwitcherState(null)
    const guestSourcePageId = guestSourcePageIdRef.current
    guestSourcePageIdRef.current = null
    const selected = current?.items[current.selectedIndex]
    if (!selected) {
      return
    }
    activateCyclableTab(useAppStore.getState(), selected)
    // Why: the held gesture pulled focus out of the source webview; when it
    // commits to a browser tab, hand focus to that page like a click would.
    if (guestSourcePageId !== null && selected.type === 'browser') {
      const pageId = resolveActiveBrowserPageId(useAppStore.getState(), selected.id)
      if (pageId !== null) {
        requestGuestPageFocus(pageId)
      }
    }
  }, [requestGuestPageFocus, setSwitcherState])

  const cancel = useCallback((): void => {
    setSwitcherState(null)
    const guestSourcePageId = guestSourcePageIdRef.current
    guestSourcePageIdRef.current = null
    if (guestSourcePageId !== null) {
      requestGuestPageFocus(guestSourcePageId)
    }
  }, [requestGuestPageFocus, setSwitcherState])

  useEffect(() => {
    const unsubscribeKeyDown = window.api.ui.onCtrlTabKeyDown(({ shiftKey }) => {
      openOrAdvance(shiftKey ? -1 : 1)
      releaseGuestFocusForHeldGesture()
    })
    const unsubscribeKeyUp = window.api.ui.onCtrlTabKeyUp(commit)
    return () => {
      unsubscribeKeyDown()
      unsubscribeKeyUp()
    }
  }, [commit, openOrAdvance, releaseGuestFocusForHeldGesture])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const store = useAppStore.getState()
      if (matchesRecentTabSwitcherChord(event, getShortcutPlatform(), store.keybindings)) {
        // Why: Electron's native before-input-event path is authoritative, but
        // CDP/test-dispatched keys can reach the renderer directly. Respect the
        // keybinding registry here too so tests do not bypass user customization.
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
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', cancel)
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
    document.body
  )
}
