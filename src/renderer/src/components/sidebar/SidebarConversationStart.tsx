import { useState } from 'react'
import { useAppStore } from '@/store'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useTranslation } from 'react-i18next'
import { SquarePen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'

export function SidebarConversationStart({
  worktreeId,
  executionHostId,
  projectName
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  projectName: string
}): React.JSX.Element | null {
  useTranslation()
  const [open, setOpen] = useState(false)
  const resolvedHost = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, worktreeId, executionHostId)
  )
  const ownsTarget = resolvedHost === executionHostId
  const target = useAgentDetectionTargetForWorktree(ownsTarget ? worktreeId : null, executionHostId)
  const { model } = useAgentMenuObservation(
    ownsTarget
      ? { workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId, executionHostId } }
      : null,
    open && ownsTarget,
    ownsTarget ? target : undefined
  )
  const rows = model.state === 'settled' ? model.rows.filter((row) => row.kind === 'chat') : []
  const label = translate('projectConversations.newChatInProject', 'New chat in {{project}}', {
    project: projectName
  })
  const launch = (row: NewTabAgentMenuRow): void => {
    if (
      row.kind !== 'chat' ||
      row.executionHostId !== executionHostId ||
      getResolvedExecutionHostIdForWorktree(useAppStore.getState(), worktreeId, executionHostId) !==
        executionHostId
    ) {
      return
    }
    launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      focusIntent: captureNativeChatComposerFocusIntent(),
      agent: row.agent,
      worktreeId,
      requestedSurface: 'chat',
      selectedExecutionHostId: row.executionHostId,
      beforeSurfaceOpen: () =>
        activateAndRevealWorkspace(worktreeId, {
          executionHostId,
          providesInitialSurface: true,
          revealInSidebar: false
        }) !== false
    })
  }
  if (!ownsTarget) {
    return null
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={label}>
              <SquarePen className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {rows.map((row) => (
          <DropdownMenuItem
            key={`${row.agent}:${row.executionHostId}`}
            onSelect={() => launch(row)}
          >
            <AgentIcon agent={row.agent} size={16} />
            {getAgentCatalog().find((agent) => agent.id === row.agent)?.label ?? row.agent}
          </DropdownMenuItem>
        ))}
        {rows.length === 0 ? (
          <DropdownMenuItem disabled>
            {model.state === 'loading'
              ? translate('dashboard.sidebar.loadingChatAgents', 'Loading chat agents…')
              : translate(
                  'dashboard.sidebar.noChatAgents',
                  'No chat agents available on this host'
                )}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
