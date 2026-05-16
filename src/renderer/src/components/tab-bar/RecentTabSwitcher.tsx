import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, GitCompare, Globe2, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../../store'
import { activateCyclableTab } from '../../hooks/ipc-tab-switch'
import {
  buildRecentTabSwitcherModel,
  getNextRecentTabSwitcherIndex,
  normalizeCtrlTabOrderMode,
  type RecentTabSwitcherItem
} from './recent-tab-switching'

type SwitcherState = {
  items: RecentTabSwitcherItem[]
  selectedIndex: number
}

function TabIcon({ item }: { item: RecentTabSwitcherItem }): React.JSX.Element {
  const className = 'size-4 shrink-0 text-muted-foreground'
  if (item.type === 'terminal') {
    return <TerminalSquare className={className} />
  }
  if (item.type === 'browser') {
    return <Globe2 className={className} />
  }
  if (item.contentType === 'diff' || item.contentType === 'conflict-review') {
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
      if (event.code === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
        // Why: Electron's native before-input-event path is authoritative, but
        // CDP/test-dispatched keys can reach the renderer directly.
        event.preventDefault()
        event.stopPropagation()
        openOrAdvance(event.shiftKey ? -1 : 1)
        return
      }
      if (!switcherRef.current || event.key !== 'Escape') {
        return
      }
      event.preventDefault()
      cancel()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (
        !switcherRef.current ||
        (event.code !== 'ControlLeft' && event.code !== 'ControlRight' && event.key !== 'Control')
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      commit()
    }
    const onBlur = (): void => cancel()
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
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
        aria-label="Switch tabs"
      >
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">
          Switch Tab
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
