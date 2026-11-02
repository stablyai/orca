import { useState } from 'react'
import { Archive, ArchiveRestore, Pin, PinOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { ConversationPreference } from '../../../../shared/conversation-navigation-preferences'
import { projectConversationTitle } from '../../../../shared/project-conversation-list'
import { useAiVaultSessionDisplayTitle } from '../right-sidebar/use-ai-vault-session-display-title'

export function ProjectConversationRow({
  session,
  preference,
  selected,
  liveState,
  onOpen,
  onPreference
}: {
  session: AiVaultSession
  preference?: ConversationPreference
  selected: boolean
  liveState: AgentDotState | null
  onOpen: () => void
  onPreference: (patch: ConversationPreference) => Promise<void>
}): React.JSX.Element {
  const savedTitle = useAiVaultSessionDisplayTitle(session)
  const title =
    projectConversationTitle(session, savedTitle) ||
    translate('projectConversations.untitled', 'Untitled chat')
  const [busy, setBusy] = useState(false)
  const pinned = preference?.pinned === true
  const archived = preference?.archived === true
  const pinLabel = pinned
    ? translate('projectConversations.unpin', 'Unpin chat')
    : translate('projectConversations.pin', 'Pin chat')
  const archiveLabel = archived
    ? translate('projectConversations.restore', 'Restore chat')
    : translate('projectConversations.archive', 'Archive chat')
  const change = async (patch: ConversationPreference) => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      await onPreference(patch)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      data-conversation-id={session.id}
      data-current={selected || undefined}
      className={cn(
        'group/chat relative flex min-h-8 min-w-0 items-center rounded-md pl-7 pr-1 text-sidebar-foreground hover:bg-sidebar-accent focus-within:bg-sidebar-accent',
        selected && 'bg-sidebar-accent'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-conversation-open=""
            onClick={onOpen}
            aria-current={selected ? 'page' : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 group-hover/chat:pr-12 group-focus-within/chat:pr-12 [@media(hover:none)]:pr-12 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-sm"
          >
            <span
              aria-hidden="true"
              className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
            >
              <AgentIcon agent={session.agent} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {liveState === 'working' ? (
              <Loader2
                aria-label={translate('projectConversations.working', 'Working')}
                className="size-3 shrink-0 animate-spin text-muted-foreground"
              />
            ) : null}
            {liveState === 'blocked' ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-(--status-warning)"
                aria-label={translate('projectConversations.needsYou', 'Needs you')}
              />
            ) : null}
            {pinned ? (
              <Pin aria-label={pinLabel} className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{title}</TooltipContent>
      </Tooltip>
      <div className="absolute right-1 inset-y-0 flex shrink-0 items-center opacity-0 group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 [@media(hover:none)]:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              aria-label={pinLabel}
              onClick={() => void change({ pinned: !pinned })}
            >
              {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{pinLabel}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              aria-label={archiveLabel}
              onClick={() => void change({ archived: !archived })}
            >
              {archived ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{archiveLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
