import React from 'react'
import { Layers } from 'lucide-react'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { resolveTaskGroupLaunchTarget } from './agent-task-group-launch-target'

const BRANCH_VALUE = '__branch__'

/** In the tab bar's + menu: which task group (or none) the agent sessions it starts are filed in. */
export function AgentTaskGroupDestinationMenu({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const groups = useAppStore((s) => resolveTaskGroupLaunchTarget(s, worktreeId).groups)
  const groupId = useAppStore((s) => resolveTaskGroupLaunchTarget(s, worktreeId).group?.id ?? null)
  const setChoice = useAppStore((s) => s.setAgentTaskGroupLaunchChoice)
  if (groups.length === 0) {
    return null
  }
  const branchLabel = t(
    'auto.components.sidebar.AgentTaskGroupDestinationMenu.branch',
    'No task group'
  )
  const current = groups.find((group) => group.id === groupId)?.name ?? branchLabel
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Layers />
          {t('auto.components.sidebar.AgentTaskGroupDestinationMenu.addTo', 'Add to: {{value0}}', {
            value0: current
          })}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-44">
          <DropdownMenuRadioGroup
            value={groupId ?? BRANCH_VALUE}
            onValueChange={(value) => {
              const target = resolveTaskGroupLaunchTarget(useAppStore.getState(), worktreeId)
              setChoice(
                target.workspaceKey,
                value === BRANCH_VALUE ? null : value,
                target.activeTabId
              )
            }}
          >
            <DropdownMenuRadioItem value={BRANCH_VALUE}>{branchLabel}</DropdownMenuRadioItem>
            {groups.map((group) => (
              <DropdownMenuRadioItem key={group.id} value={group.id}>
                {group.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  )
}
