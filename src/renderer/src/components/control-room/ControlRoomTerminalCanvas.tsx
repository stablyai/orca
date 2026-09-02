import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Pin, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import { useLiveDashboardSnapshot } from '../dashboard/useLiveDashboardSnapshot'
import { activateCanvasTerminal } from '../tab-group/activate-canvas-terminal'
import type { CanvasTerminalItem } from '../tab-group/CanvasTerminalCard'
import TabGroupCanvasLayout from '../tab-group/TabGroupCanvasLayout'
import { usePaneCanvasWorkspaceState } from '../tab-group/use-pane-canvas-workspace-state'
import {
  DEFAULT_CONTROL_ROOM_PREFERENCES,
  readControlRoomPreferences,
  writeControlRoomPreferences,
  type ControlRoomPreferences,
  type ControlRoomScope
} from './control-room-preferences'
import { buildControlRoomTerminalItems } from './control-room-terminal-items'

export type ControlRoomTerminalVisibility = {
  terminalTabIdsByWorktree: Readonly<Record<string, ReadonlySet<string>>>
  visibleTerminalTabIdsByWorktree: Readonly<Record<string, ReadonlySet<string>>>
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function idsByWorktree(
  items: readonly CanvasTerminalItem[],
  includedTerminalTabIds?: ReadonlySet<string>
): Record<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>()
  for (const item of items) {
    if (
      !item.worktreeId ||
      (includedTerminalTabIds && !includedTerminalTabIds.has(item.terminalTabId))
    ) {
      continue
    }
    const ids = mutable.get(item.worktreeId) ?? new Set<string>()
    ids.add(item.terminalTabId)
    mutable.set(item.worktreeId, ids)
  }
  return Object.fromEntries(mutable)
}

function haveSameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && Array.from(left).every((id) => right.has(id))
}

export default function ControlRoomTerminalCanvas({
  onTerminalVisibilityChange
}: {
  onTerminalVisibilityChange: (visibility: ControlRoomTerminalVisibility) => void
}): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()
  const unifiedTabsByWorktree = useAppStore((state) => state.unifiedTabsByWorktree)
  const terminalTabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const generatedTabTitlesEnabled = useAppStore(
    (state) => state.settings?.tabAutoGenerateTitle === true
  )
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const [preferences, setPreferencesState] = useState<ControlRoomPreferences>(() => {
    const storage = browserStorage()
    return storage ? readControlRoomPreferences(storage) : DEFAULT_CONTROL_ROOM_PREFERENCES
  })
  const pinnedSessionKeys = useMemo(
    () => new Set(preferences.pinnedSessionKeys),
    [preferences.pinnedSessionKeys]
  )
  const terminalItems = useMemo(
    () =>
      buildControlRoomTerminalItems({
        cards: snapshot.cards,
        workspaces: snapshot.workspaces,
        unifiedTabsByWorktree,
        terminalTabsByWorktree,
        ptyIdsByTabId,
        generatedTabTitlesEnabled,
        pinnedSessionKeys,
        scope: preferences.scope
      }),
    [
      generatedTabTitlesEnabled,
      pinnedSessionKeys,
      preferences.scope,
      ptyIdsByTabId,
      snapshot.cards,
      snapshot.workspaces,
      terminalTabsByWorktree,
      unifiedTabsByWorktree
    ]
  )
  const terminalTabIds = useMemo(
    () => terminalItems.map((item) => item.terminalTabId),
    [terminalItems]
  )
  const [visibleTerminalTabIds, setVisibleTerminalTabIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const handleVisibleTerminalTabIdsChange = useCallback((next: ReadonlySet<string>) => {
    setVisibleTerminalTabIds((current) => (haveSameIds(current, next) ? current : next))
  }, [])
  const { canvasState, updateCanvasState } = usePaneCanvasWorkspaceState({
    ownerKey: `control-room:${preferences.scope}`,
    terminalTabIds,
    preserveMissingBounds: true
  })

  const setPreferences = useCallback(
    (updater: (current: ControlRoomPreferences) => ControlRoomPreferences) => {
      setPreferencesState((current) => {
        const next = updater(current)
        const storage = browserStorage()
        if (storage) {
          writeControlRoomPreferences(storage, next)
        }
        return next
      })
    },
    []
  )

  const setScope = useCallback(
    (scope: ControlRoomScope) => setPreferences((current) => ({ ...current, scope })),
    [setPreferences]
  )

  const togglePinned = useCallback(
    (item: CanvasTerminalItem) => {
      if (!item.sessionKey) {
        return
      }
      setPreferences((current) => {
        const pins = new Set(current.pinnedSessionKeys)
        if (pins.has(item.sessionKey!)) {
          pins.delete(item.sessionKey!)
        } else {
          pins.add(item.sessionKey!)
        }
        return { ...current, pinnedSessionKeys: Array.from(pins) }
      })
    },
    [setPreferences]
  )

  const activateTerminal = useCallback((item: CanvasTerminalItem) => {
    if (!item.worktreeId) {
      return
    }
    const store = useAppStore.getState()
    if (store.activeWorktreeId !== item.worktreeId) {
      store.setActiveWorktree(item.worktreeId, item.executionHostId)
    }
    activateCanvasTerminal({
      worktreeId: item.worktreeId,
      groupId: item.groupId,
      unifiedTabId: item.unifiedTabId,
      terminalTabId: item.terminalTabId
    })
    const activeLeafId = store.terminalLayoutsByTabId[item.terminalTabId]?.activeLeafId ?? null
    requestAnimationFrame(() => focusTerminalTabSurface(item.terminalTabId, activeLeafId))
  }, [])

  useEffect(() => {
    const selected = idsByWorktree(terminalItems)
    const visible = idsByWorktree(terminalItems, visibleTerminalTabIds)
    onTerminalVisibilityChange({
      terminalTabIdsByWorktree: selected,
      visibleTerminalTabIdsByWorktree: visible
    })
  }, [onTerminalVisibilityChange, terminalItems, visibleTerminalTabIds])

  useEffect(
    () => () =>
      onTerminalVisibilityChange({
        terminalTabIdsByWorktree: {},
        visibleTerminalTabIdsByWorktree: {}
      }),
    [onTerminalVisibilityChange]
  )

  const focusedTerminalTabId = terminalItems.some(
    (item) => item.worktreeId === activeWorktreeId && item.terminalTabId === activeTabId
  )
    ? (activeTabId ?? undefined)
    : undefined

  const scopeButton = (
    scope: ControlRoomScope,
    label: string,
    icon: React.JSX.Element
  ): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant={preferences.scope === scope ? 'secondary' : 'ghost'}
          aria-label={label}
          aria-pressed={preferences.scope === scope}
          onClick={() => setScope(scope)}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <TabGroupCanvasLayout
      terminalItems={terminalItems}
      focusedTerminalTabId={focusedTerminalTabId}
      canvasState={canvasState}
      updateCanvasState={updateCanvasState}
      onVisibleTerminalTabIdsChange={handleVisibleTerminalTabIdsChange}
      title={translate(
        'auto.components.control.room.ControlRoomTerminalCanvas.title',
        'Control Room'
      )}
      showSplitsButton={false}
      allowTerminalCreation={false}
      trailingChromeInset="window-controls"
      onActivateItem={activateTerminal}
      onTogglePinned={togglePinned}
      toolbarContent={
        <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-border pl-1">
          {scopeButton(
            'active',
            translate(
              'auto.components.control.room.ControlRoomTerminalCanvas.active',
              'Active agents'
            ),
            <Bot />
          )}
          {scopeButton(
            'all',
            translate(
              'auto.components.control.room.ControlRoomTerminalCanvas.all',
              'All live sessions'
            ),
            <SquareTerminal />
          )}
          {scopeButton(
            'pinned',
            translate('auto.components.control.room.ControlRoomTerminalCanvas.pinned', 'Pinned'),
            <Pin />
          )}
          <span
            className="min-w-4 text-center text-[10px] tabular-nums text-muted-foreground"
            aria-label={translate(
              'auto.components.control.room.ControlRoomTerminalCanvas.sessionCount',
              'Sessions in this view: {{value0}}',
              { value0: terminalItems.length }
            )}
          >
            {translate(
              'auto.components.control.room.ControlRoomTerminalCanvas.sessionCountCompact',
              '{{value0}}',
              { value0: terminalItems.length }
            )}
          </span>
        </div>
      }
      emptyState={
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <Bot className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">
              {preferences.scope === 'pinned'
                ? translate(
                    'auto.components.control.room.ControlRoomTerminalCanvas.noPinned',
                    'No pinned sessions yet'
                  )
                : translate(
                    'auto.components.control.room.ControlRoomTerminalCanvas.noAgents',
                    'No agents match this view'
                  )}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.control.room.ControlRoomTerminalCanvas.emptyHelp',
                'Active shows recognized agents. All adds ordinary live terminals. Recognized subagents stay folded into their parent count.'
              )}
            </p>
          </div>
        </div>
      }
    />
  )
}
