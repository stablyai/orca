import React from 'react'
import { CirclePlay, KeyRound } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import {
  cloudAgentHoldTabId,
  useCloudAgentHolds,
  type CloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'

/** The hold waiting in one of this workspace's tabs, if any. */
export function useWorktreeCloudAgentHold(worktreeId: string): CloudAgentHold | null {
  const holds = useCloudAgentHolds()
  const tabIds = useAppStore((state) => state.tabsByWorktree[worktreeId])
  // A structured chat's hold is keyed by its own tab (CHAT-BANNERS).
  const chatTabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId])
  if (holds.length === 0 || (!tabIds?.length && !chatTabs?.length)) {
    return null
  }
  const ids = new Set([...(tabIds ?? []), ...(chatTabs ?? [])].map((tab) => tab.id))
  return holds.find((hold) => ids.has(cloudAgentHoldTabId(hold.paneKey))) ?? null
}

/**
 * N-03 (design-squad): the sidebar row's mark for a workspace whose agent waits on its pane's strip
 * ("Set up once" or a sign-in renewal). It replaces the toast that followed the user around: away
 * from the workspace this mark is the signal; in it, the strip asks.
 */
export function CloudAgentHeldMark({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hold = useWorktreeCloudAgentHold(worktreeId)
  if (!hold) {
    return null
  }
  const agent = agentName(hold.agent, t)
  const waiting = hold.reason === 'awaitingStart'
  const label = waiting
    ? t(
        'orcaCloud.agentHold.notStarted',
        '{{agent}} hasn’t started. Open the workspace to start it.',
        {
          agent
        }
      )
    : hold.reason === 'accountExpired'
      ? t('orcaCloud.agentHold.expired', '{{agent}} sign-in expired', { agent })
      : t('orcaCloud.agentHold.notSetUp', '{{agent}} isn’t set up for Orca Cloud', { agent })
  const Icon = waiting ? CirclePlay : KeyRound
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-cloud-agent-held={hold.reason}
          className={cn(
            'inline-flex size-3.5 shrink-0 items-center justify-center',
            // V3-01: a restored launch waiting for Start is no alarm: muted, not the amber key.
            waiting ? 'text-muted-foreground' : 'text-status-warning-text'
          )}
        >
          <Icon className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
