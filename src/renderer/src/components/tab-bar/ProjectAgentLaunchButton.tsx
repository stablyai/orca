import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useWorkspaceAgentDefault } from '../agent/project-agent-default'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { notifyAgentLaunchFailure } from '@/lib/agent-session/launch/failure/agent-launch-failure'
import { restoreWorktreeCreateMenuSurface } from '../sidebar/workspace-card/surface/restore-worktree-create-menu-surface'
import { workspaceRootGroupId } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useTabAgentMenuLaunch } from './QuickLaunchButton'

export function ProjectAgentLaunchButton({
  worktreeId,
  executionHostId,
  disabled
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  disabled?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const project = useWorkspaceAgentDefault(worktreeId, executionHostId)
  const choice = project?.agentLaunchDefault
  const [pending, setPending] = useState(false)
  const resolveGroupId = useCallback(
    () =>
      useAppStore.getState().activeGroupIdByWorktree[worktreeId] ??
      workspaceRootGroupId(worktreeId),
    [worktreeId]
  )
  const launch = useTabAgentMenuLaunch({
    worktreeId,
    groupId: workspaceRootGroupId(worktreeId),
    resolveGroupId,
    onFocusTerminal: focusTerminalTabSurface
  })
  if (!choice) {
    return null
  }
  const description = [
    getAgentLabel(choice.agent),
    choice.choices.model,
    choice.choices.options?.effort,
    choice.surface
  ]
    .filter(Boolean)
    .join(' · ')
  const label = t('sidebar.projectDefault.launch', 'Launch {{setup}}', { setup: description })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0"
          aria-label={label}
          aria-busy={pending}
          disabled={disabled || pending}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            if (
              pending ||
              activateAndRevealWorktree(worktreeId, {
                providesInitialSurface: true,
                executionHostId
              }) === false
            ) {
              return
            }
            setPending(true)
            void Promise.resolve()
              .then(() =>
                launch(
                  {
                    agent: choice.agent,
                    kind: choice.surface === 'chat' ? 'chat' : 'cli',
                    executionHostId
                  },
                  choice
                )
              )
              .then((accepted) => {
                if (!accepted) {
                  restoreWorktreeCreateMenuSurface(worktreeId, executionHostId)
                }
              })
              .catch(() => {
                restoreWorktreeCreateMenuSurface(worktreeId, executionHostId)
                notifyAgentLaunchFailure(choice.agent)
              })
              .finally(() => setPending(false))
          }}
        >
          <AgentIcon agent={choice.agent} size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
