import { useCallback, useEffect, useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { QuickLaunchAgentMenuItems } from '../tab-bar/QuickLaunchButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { ALL_TUI_AGENTS } from '../../../../shared/tui-agent-display-names'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { reportAgentCardHidden } from './agent-card-pane-visibility'
import { tiledPaneFrameClassName, type TiledPaneFrameTone } from './tiled-pane-attention'

const CARD_BUTTON_CLASS_NAME =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground'

function asTuiAgent(value: string | null | undefined): TuiAgent | null {
  if (!value) {
    return null
  }
  for (const agent of ALL_TUI_AGENTS) {
    if (agent === value) {
      return agent
    }
  }
  return null
}

export function AgentCard({
  worktreeId,
  cardGroupId,
  tabId,
  isMaximized,
  frameTone
}: {
  worktreeId: string
  cardGroupId: string
  tabId: string
  isMaximized: boolean
  frameTone?: TiledPaneFrameTone
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const label = useAppStore((state) => {
    const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === tabId
    )
    return resolveUnifiedTabLabel(tab, state.settings?.tabAutoGenerateTitle === true, '')
  })
  const agent = useAppStore((state): TuiAgent | null => {
    const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === tabId
    )
    if (tab?.contentType === 'agent-session') {
      return asTuiAgent(tab.agentSessionAgent)
    }
    if (tab?.contentType !== 'terminal') {
      return null
    }
    return asTuiAgent(
      (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tab.entityId)
        ?.launchAgent
    )
  })
  const toggleMaximizedAgentCard = useAppStore((state) => state.toggleMaximizedAgentCard)
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const focusGroup = useAppStore((state) => state.focusGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const focusCardGroup = useCallback(() => {
    focusGroup(worktreeId, cardGroupId)
  }, [cardGroupId, focusGroup, worktreeId])
  const bodyAnchorName = tabGroupBodyAnchorName(cardGroupId)
  const bodyAnchorStyle = useMemo(
    () => ({ anchorName: bodyAnchorName }) as React.CSSProperties,
    [bodyAnchorName]
  )
  const frameClassName = tiledPaneFrameClassName(frameTone ?? 'plain')
  const enlargeLabel = isMaximized
    ? translate('auto.components.tab.group.AgentCard.restore', 'Restore agent')
    : translate('auto.components.tab.group.AgentCard.enlarge', 'Enlarge agent')
  const closeLabel = translate('auto.components.tab.group.AgentCard.close', 'Close agent')
  const plusLabel = translate('auto.components.tab.group.AgentCard.plus', 'Launch agent')

  useEffect(() => {
    const body = bodyRef.current
    const root = body?.closest('[data-orca-agent-cards]')
    if (!body || !(root instanceof Element) || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        reportAgentCardHidden(worktreeId, cardGroupId, entry ? !entry.isIntersecting : false)
      },
      { root, threshold: 0 }
    )
    observer.observe(body)
    return () => {
      observer.disconnect()
      reportAgentCardHidden(worktreeId, cardGroupId, false)
    }
  }, [cardGroupId, worktreeId])

  return (
    <div
      className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden', frameClassName)}
      onPointerDown={focusCardGroup}
      // Why: keyboard/AT focus can enter a card without a pointer event, so sync group focus to DOM focus for card shortcuts.
      onFocusCapture={focusCardGroup}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <AgentIcon agent={agent} size={14} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={enlargeLabel}
              className={CARD_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.stopPropagation()
                toggleMaximizedAgentCard(worktreeId, cardGroupId)
              }}
            >
              {isMaximized ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {enlargeLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={plusLabel}
                  className={CARD_BUTTON_CLASS_NAME}
                  onClick={(event) => {
                    event.stopPropagation()
                  }}
                >
                  <Plus className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {plusLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
            <QuickLaunchAgentMenuItems
              worktreeId={worktreeId}
              groupId={cardGroupId}
              launchSource="agent_card_plus"
              onFocusTerminal={(nextTabId) => {
                activateTab(nextTabId, { worktreeId })
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={closeLabel}
              className={CARD_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.stopPropagation()
                closeUnifiedTab(tabId)
              }}
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {closeLabel}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={bodyRef}
        data-tab-group-body-id={cardGroupId}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        style={bodyAnchorStyle}
      />
    </div>
  )
}
