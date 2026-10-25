import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, GitCompare, Globe2, Smartphone, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import type { AppState } from '@/store/types'
import { activateCyclableTab } from '../../hooks/ipc-tab-switch'
import { getShortcutPlatform } from '../../hooks/useShortcutLabel'
import { formatKeybinding } from '../../../../shared/keybindings'
import type { CtrlTabScope } from '../../../../shared/tab-types'
import {
  isRecentTabSwitcherScopeToggle,
  RECENT_TAB_SWITCHER_SCOPE_TOGGLE_KEYBINDING
} from '../../../../shared/recent-tab-switcher-scope-toggle'
import {
  isRecentTabSwitcherCommitRelease,
  matchesRecentTabSwitcherChord
} from '../../../../shared/window-shortcut-policy'
import {
  buildRecentTabSwitcherModel,
  getNextRecentTabSwitcherIndex,
  normalizeCtrlTabOrderMode,
  normalizeCtrlTabScope,
  type RecentTabSwitcherItem
} from './recent-tab-switching'
import {
  buildAllWorkspacesRecentTabSwitcherModel,
  type AllWorkspacesRecentTabItem
} from './all-workspaces-recent-tab-switching'
import { activateOpenTabSearchResult } from './open-tab-selection-routing'
import { focusEditorInOtherPane, focusTabInOtherPane } from './switcher-pane-focus'
import { getVisibleWorktreeShortcutTargets } from '../sidebar/visible-worktrees'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

type SwitcherState =
  | {
      scope: 'workspace'
      items: RecentTabSwitcherItem[]
      selectedIndex: number
      /** No workspace is on screen, so this scope has no tabs to list. */
      outsideWorkspace?: boolean
    }
  | { scope: 'all'; items: AllWorkspacesRecentTabItem[]; selectedIndex: number }

type SwitcherModel<T extends { key: string }> = { items: T[]; activeIndex: number }

function consumeKeyboardEvent(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function getNextSelectedIndex(
  model: SwitcherModel<{ key: string }>,
  previous: SwitcherState | null,
  scope: CtrlTabScope,
  direction: 1 | -1
): number {
  const selectedKey =
    previous?.scope === scope ? (previous.items[previous.selectedIndex]?.key ?? null) : null
  const currentIndex =
    selectedKey == null
      ? model.activeIndex
      : model.items.findIndex((item) => item.key === selectedKey)
  return getNextRecentTabSwitcherIndex(model.items.length, currentIndex, direction)
}

// Why: the model is rebuilt on every press so tabs opened or closed mid-gesture are not stale.
function buildSwitcherState(
  store: AppState,
  scope: CtrlTabScope,
  previous: SwitcherState | null,
  direction: 1 | -1
): SwitcherState | null {
  const mode = normalizeCtrlTabOrderMode(store.settings?.ctrlTabOrderMode)
  if (scope === 'all') {
    const model = buildAllWorkspacesRecentTabSwitcherModel(store, {
      mode,
      // Why: Tab strip order puts the workspaces in the rendered sidebar order, as Cmd+1-9 do.
      sidebarOrder: mode === 'sequential' ? getVisibleWorktreeShortcutTargets() : []
    }) ?? { items: [], activeIndex: -1 }
    return {
      scope,
      items: model.items,
      selectedIndex: getNextSelectedIndex(model, previous, scope, direction)
    }
  }
  if (store.activeView !== 'terminal' || !store.activeWorktreeId) {
    return null
  }
  // Why: a single-tab workspace still opens the switcher so Ctrl+A can reach the other workspaces.
  const model = buildRecentTabSwitcherModel(store, store.activeWorktreeId, mode) ?? {
    items: [],
    activeIndex: -1
  }
  return {
    scope,
    items: model.items,
    selectedIndex: getNextSelectedIndex(model, previous, scope, direction)
  }
}

function buildScopeSwitcherState(store: AppState, scope: CtrlTabScope): SwitcherState {
  return (
    buildSwitcherState(store, scope, null, 1) ?? {
      scope: 'workspace',
      items: [],
      selectedIndex: -1,
      outsideWorkspace: true
    }
  )
}

function commitAllWorkspacesItem(item: AllWorkspacesRecentTabItem): void {
  const store = useAppStore.getState()
  const { worktreeId } = item.result
  // Why: a pane of another workspace, or a pane behind another view, had no focus to keep.
  const paneBefore =
    store.activeView === 'terminal' && store.activeWorktreeId === worktreeId
      ? store.activeGroupIdByWorktree[worktreeId]
      : undefined
  const outcome = activateOpenTabSearchResult(item.result)
  if (outcome.status === 'failed') {
    toast.error(outcome.message)
    return
  }
  if (outcome.status === 'activated') {
    outcome.focus?.()
    if (item.type === 'editor') {
      focusEditorInOtherPane(worktreeId, paneBefore)
    }
  }
}

function TabIcon({
  item
}: {
  item: Pick<RecentTabSwitcherItem, 'type' | 'contentType' | 'agent'>
}): React.JSX.Element {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  if (item.agent) {
    return (
      <span className="inline-flex shrink-0" data-agent-icon={item.agent} aria-hidden="true">
        <AgentIcon agent={item.agent} size={14} />
      </span>
    )
  }
  // Why: like the tab strip, a chat whose agent is unknown shows the terminal glyph.
  if (item.type === 'terminal' || item.type === 'agent-session') {
    return <TerminalSquare className={className} />
  }
  if (item.type === 'browser') {
    return <Globe2 className={className} />
  }
  if (item.type === 'simulator') {
    return <Smartphone className={className} />
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

function scopeLabel(scope: CtrlTabScope): string {
  return scope === 'all'
    ? translate('auto.components.tab.bar.RecentTabSwitcher.scopeAll', 'All workspaces')
    : translate('auto.components.tab.bar.RecentTabSwitcher.scopeWorkspace', 'This workspace')
}

export default function RecentTabSwitcher(): React.JSX.Element | null {
  const [switcher, setSwitcher] = useState<SwitcherState | null>(null)
  const switcherRef = useRef<SwitcherState | null>(null)
  // Why: the store gets a new scope only after its save returns, so a fast next Ctrl+Tab reads it here.
  const pendingScopeRef = useRef<{ scope: CtrlTabScope } | null>(null)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)

  const setSwitcherState = useCallback((next: SwitcherState | null): void => {
    switcherRef.current = next
    setSwitcher(next)
  }, [])

  const openOrAdvance = useCallback(
    (direction: 1 | -1): void => {
      const store = useAppStore.getState()
      const current = switcherRef.current
      const scope =
        current?.scope ??
        pendingScopeRef.current?.scope ??
        normalizeCtrlTabScope(store.settings?.ctrlTabScope)
      const next = buildSwitcherState(store, scope, current, direction)
      if (next) {
        setSwitcherState(next)
      }
    },
    [setSwitcherState]
  )

  const toggleScope = useCallback((): void => {
    const current = switcherRef.current
    if (!current) {
      return
    }
    const store = useAppStore.getState()
    const scope: CtrlTabScope = current.scope === 'all' ? 'workspace' : 'all'
    // Why: the scope is sticky, so the next Ctrl+Tab opens where the user left it.
    const pending = { scope }
    pendingScopeRef.current = pending
    void store
      .updateSettingsOrThrow({ ctrlTabScope: scope })
      .then(() => {
        // Why: only the last save puts its scope in the store, and an older save can return first.
        if (pendingScopeRef.current === pending) {
          pendingScopeRef.current = null
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to save the Ctrl+Tab scope:', error)
        if (pendingScopeRef.current !== pending) {
          return
        }
        pendingScopeRef.current = null
        // Why: the store kept the saved scope, so the box shows the scope that the next Ctrl+Tab opens.
        if (switcherRef.current?.scope === scope) {
          const latest = useAppStore.getState()
          setSwitcherState(
            buildScopeSwitcherState(latest, normalizeCtrlTabScope(latest.settings?.ctrlTabScope))
          )
        }
      })
    setSwitcherState(buildScopeSwitcherState(store, scope))
  }, [setSwitcherState])

  const commit = useCallback((): void => {
    const current = switcherRef.current
    setSwitcherState(null)
    if (current?.scope === 'all') {
      const selected = current.items[current.selectedIndex]
      if (selected) {
        commitAllWorkspacesItem(selected)
      }
      return
    }
    const selected = current?.items[current.selectedIndex]
    if (selected) {
      const store = useAppStore.getState()
      const worktreeId = store.activeWorktreeId
      const paneBefore = worktreeId ? store.activeGroupIdByWorktree[worktreeId] : undefined
      activateCyclableTab(store, selected)
      if (worktreeId) {
        focusTabInOtherPane(worktreeId, selected, paneBefore)
      }
    }
  }, [setSwitcherState])

  // Why: rows open on mouseup, as macOS turns a Ctrl+click into a context menu and sends no click.
  const commitRow = useCallback(
    (index: number): void => {
      const current = switcherRef.current
      if (!current) {
        return
      }
      switcherRef.current = { ...current, selectedIndex: index }
      commit()
    },
    [commit]
  )

  const cancel = useCallback((): void => {
    setSwitcherState(null)
  }, [setSwitcherState])

  useEffect(() => {
    const unsubscribeKeyDown = window.api.ui.onCtrlTabKeyDown(({ shiftKey }) => {
      openOrAdvance(shiftKey ? -1 : 1)
    })
    const unsubscribeKeyUp = window.api.ui.onCtrlTabKeyUp(commit)
    // Why: a dev reload can pair this renderer with an older preload that lacks the toggle.
    const unsubscribeToggleScope = window.api.ui.onCtrlTabToggleScope?.(toggleScope)
    return () => {
      unsubscribeKeyDown()
      unsubscribeKeyUp()
      unsubscribeToggleScope?.()
    }
  }, [commit, openOrAdvance, toggleScope])

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
      if (isRecentTabSwitcherScopeToggle(event, getShortcutPlatform())) {
        consumeKeyboardEvent(event)
        if (!event.repeat) {
          toggleScope()
        }
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
  }, [cancel, commit, openOrAdvance, toggleScope])

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [switcher?.scope, switcher?.selectedIndex])

  if (!switcher) {
    return null
  }

  const otherScope: CtrlTabScope = switcher.scope === 'all' ? 'workspace' : 'all'
  const rows: (RecentTabSwitcherItem | AllWorkspacesRecentTabItem)[] = switcher.items

  // Why: Control is held, so a click that reached the app would be a Ctrl+click there.
  // The layer takes every click, and a click outside the box cancels.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh]"
      onMouseDown={(event) => event.preventDefault()}
      onMouseUp={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) {
          cancel()
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* Why: both scopes share one width so Ctrl+A does not move the box. */}
      <div
        className="w-[min(40rem,calc(100vw-3rem))] cursor-default overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
        role="listbox"
        aria-label={translate(
          'auto.components.tab.bar.RecentTabSwitcher.07ad4cd0b7',
          'Switch tabs'
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-2 py-1 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate font-semibold">
            {translate('auto.components.tab.bar.RecentTabSwitcher.329638ff6f', 'Switch Tab')}
            {' · '}
            {scopeLabel(switcher.scope)}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ShortcutKeyCombo
              keys={formatKeybinding(
                RECENT_TAB_SWITCHER_SCOPE_TOGGLE_KEYBINDING,
                getShortcutPlatform()
              )}
            />
            {scopeLabel(otherScope)}
          </span>
        </div>
        <div className="max-h-[min(18rem,60vh)] overflow-y-auto scrollbar-sleek py-0.5">
          {rows.length === 0 ? (
            <div className="flex h-6 items-center px-2 text-xs text-muted-foreground">
              {switcher.scope === 'workspace' && switcher.outsideWorkspace
                ? translate(
                    'auto.components.tab.bar.RecentTabSwitcher.outsideWorkspace',
                    'Go to a workspace to see its tabs'
                  )
                : translate(
                    'auto.components.tab.bar.RecentTabSwitcher.noOtherTabs',
                    'No other tabs'
                  )}
            </div>
          ) : null}
          {rows.map((item, index) => {
            const selected = index === switcher.selectedIndex
            // Why: hover is lighter than bg-accent, the dark selected surface, as hover does not select.
            return (
              <div
                key={item.key}
                ref={selected ? selectedRowRef : undefined}
                role="option"
                aria-selected={selected}
                data-selected={selected}
                onMouseUp={(event) => {
                  if (event.button === 0) {
                    commitRow(index)
                  }
                }}
                className={cn(
                  'jump-palette-item flex h-6 cursor-pointer items-center gap-1.5 px-2 text-xs text-foreground',
                  !selected && 'hover:bg-accent/50'
                )}
              >
                <TabIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.isDirty ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                ) : null}
                {'location' in item ? (
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                    {item.location}
                  </span>
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
