import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ChatAgentMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import { MetricPair, ROW_TRAILING_GUTTER_CLS } from './resource-usage-metrics'
import { isResourceSessionActivationKey } from '../session-actions/resource-session-navigation'

/** A chat agent and the processes running under it; it stops from the chat, so the row has no kill action. */
export function ChatRow({
  chat,
  onOpen
}: {
  chat: ChatAgentMemory
  /** Absent when this window can't reach the chat's workspace, so the row is read-only. */
  onOpen?: (agentSessionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const agent = isTuiAgent(chat.agent) ? chat.agent : null
  const agentLabel = agent ? getAgentLabel(agent) : chat.agent
  const open = onOpen ? (): void => onOpen(chat.agentSessionId) : undefined
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'flex items-center gap-2 pl-10 pr-3 py-1.5',
            open && 'cursor-pointer hover:bg-accent/40'
          )}
          onClick={open}
          role={open ? 'button' : undefined}
          tabIndex={0}
          onKeyDown={
            open
              ? (e) => {
                  if (isResourceSessionActivationKey(e.key)) {
                    e.preventDefault()
                    open()
                  }
                }
              : undefined
          }
        >
          <AgentIcon agent={agent} size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {chat.name?.trim() || agentLabel}
          </span>
          <MetricPair cpu={chat.cpu} memory={chat.memory} size="small" />
          <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="z-[70]">
        {t(
          'resourceManager.chatRow.tooltip',
          '{{agent}} chat, including the processes running under it',
          { agent: agentLabel }
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Agent processes no single chat owns, such as a server several chats share. */
export function SharedAgentProcessesRow({
  usage
}: {
  usage: { cpu: number; memory: number }
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {t('resourceManager.sharedAgentProcesses', 'Shared agent processes')}
      </span>
      <MetricPair cpu={usage.cpu} memory={usage.memory} />
      <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
    </div>
  )
}
