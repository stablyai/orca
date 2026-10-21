import React from 'react'
import { Box } from 'lucide-react'
import {
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { MachineMenuItems } from '@/components/machines/MachineMenuItems'
import { machineHostKeyForWorktree } from '@/lib/machines/machine-host-match'
import { useMachineForHost } from '@/store/machines'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/** The worktree's machine and its actions, so the default Projects view can reach them too. */
export function WorktreeMachineSubMenu({
  worktree,
  repo
}: {
  worktree: Worktree
  repo: Repo | null | undefined
}): React.JSX.Element | null {
  const machine = useMachineForHost(machineHostKeyForWorktree(worktree, repo))
  if (!machine) {
    return null
  }
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Box className="size-3.5" />
          <span className="truncate">{machine.machine.name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <MachineMenuItems
            match={machine}
            label={`${machine.machine.name} · ${machine.snapshot.name}`}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  )
}
