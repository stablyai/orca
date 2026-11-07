import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import React, { useCallback, useState } from 'react'
import { Activity, CircleX } from 'lucide-react'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import type { SlotLineKind } from './worktree-card-slot-signal'
import { openSlotTarget, type SlotTarget } from './worktree-card-slot-targets'

/** The slot's glyphs, so a count or menu item reads the same as the row it stands for. */
export function SlotKindGlyph({
  kind,
  monitoring = false,
  spinnerClassName = 'size-2'
}: {
  kind: SlotLineKind
  /** Working, but watching rather than taking turns. */
  monitoring?: boolean
  spinnerClassName?: string
}): React.JSX.Element | null {
  switch (kind) {
    case 'needs':
      return <AgentQuestionIcon className="size-2.5 shrink-0" />
    case 'failed':
      return <CircleX className="size-2.5 shrink-0 text-destructive" aria-hidden />
    case 'working':
      return monitoring ? (
        <Activity className="size-2.5 shrink-0 text-agent-working" aria-hidden />
      ) : (
        <AgentWorkingSpinner className={cn(spinnerClassName, 'border-[1.5px]')} />
      )
    case 'unread':
      return <span className="size-1.5 shrink-0 rounded-full bg-unread" />
    case 'seen':
    case 'idle':
      return null
  }
}

function tabTitle(worktreeId: string, tabId: string): string | null {
  const state = useAppStore.getState()
  const terminal = state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  const unified = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  return terminal?.customTitle || terminal?.title || unified?.label || null
}

function targetText(target: SlotTarget): string {
  if (target.entry) {
    return getAgentRowPrimaryText(target.entry) || formatAgentTypeLabel(target.agentType)
  }
  if (target.tabId !== undefined) {
    return (
      tabTitle(target.worktreeId, target.tabId) ??
      translate('sidebar.cardSlot.unreadTab', 'Unread tab')
    )
  }
  return target.markedByUser
    ? translate('sidebar.cardSlot.markedUnread', 'Marked unread by you')
    : translate('sidebar.cardSlot.workspaceUnread', 'Unread in this workspace')
}

function SlotTargetMenuItem({
  target,
  now
}: {
  target: SlotTarget
  now: number
}): React.JSX.Element {
  // The menu is transient, so a snapshot of the name is enough.
  const workspaceName =
    useAppStore.getState().getKnownWorktreeById(target.worktreeId, target.executionHostId)
      ?.displayName ?? ''
  return (
    <DropdownMenuItem onSelect={() => openSlotTarget(target)}>
      <div className="grid w-full grid-cols-[10px_12px_minmax(0,1fr)_auto] gap-x-1.5 gap-y-0.5 text-xs">
        <span className="flex justify-center">
          <SlotKindGlyph kind={target.kind} />
        </span>
        {target.agentType ? <AgentTypeIcon agentType={target.agentType} size={12} /> : <span />}
        <span className="truncate">{targetText(target)}</span>
        <span className="text-3xs text-muted-foreground tabular-nums">
          {target.at === null ? '' : formatShortTimeAgo(target.at, now)}
        </span>
        {workspaceName ? (
          <span className="col-start-3 col-end-5 truncate text-2xs text-muted-foreground">
            {workspaceName}
          </span>
        ) : null}
      </div>
    </DropdownMenuItem>
  )
}

/**
 * Makes a rolled-up signal a way in: one source opens directly, several open a menu of just
 * those sources. Targets resolve on press so the card never subscribes to them.
 */
export function SlotJumpTrigger({
  resolveTargets,
  label,
  className,
  children
}: {
  resolveTargets: () => SlotTarget[]
  label: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ sources: SlotTarget[]; openedAt: number } | null>(null)
  const activate = useCallback(() => {
    const targets = resolveTargets()
    if (targets.length > 1) {
      setMenu({ sources: targets, openedAt: Date.now() })
    } else if (targets[0]) {
      openSlotTarget(targets[0])
    }
  }, [resolveTargets])
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setMenu(null)
    }
  }, [])

  return (
    <DropdownMenu open={menu !== null} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'cursor-pointer rounded-[5px] outline-none hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
          // The card treats presses as select/drag; this one only opens its target.
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
          }}
          onClick={(event) => {
            event.stopPropagation()
            activate()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
              event.preventDefault()
              event.stopPropagation()
              activate()
            }
          }}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      {menu ? (
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {menu.sources.map((target) => (
            <SlotTargetMenuItem
              key={`${composeWorktreeHostIdentity(target.executionHostId, target.worktreeId)}\n${target.paneKey ?? ''}\n${target.tabId ?? ''}`}
              target={target}
              now={menu.openedAt}
            />
          ))}
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}
