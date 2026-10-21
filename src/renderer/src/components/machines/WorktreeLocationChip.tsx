import React, { useMemo } from 'react'
import { Box, Monitor, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { useMachineForHost } from '@/store/machines'
import {
  getLocalExecutionHostLabel,
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { describeMachine } from '@/lib/machines/machine-copy'
import { getMachineDisplayState } from '@/lib/machines/machine-display-state'
import { machineHostKeyForWorktree } from '@/lib/machines/machine-host-match'
import { MachineMenuItems } from './MachineMenuItems'
import { MachineStateDot } from './MachineStateLabel'

function useWorktreeHostId(worktreeId: string): {
  hostId: ExecutionHostId | null
  machineHostKey: ExecutionHostId | null
} {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  return useMemo(() => {
    const worktree = findWorktreeById(worktreesByRepo, worktreeId)
    if (!worktree) {
      return { hostId: null, machineHostKey: null }
    }
    const repo = repos.find((candidate) => candidate.id === worktree.repoId)
    return {
      hostId: getWorktreeExecutionHostId(worktree, repo),
      machineHostKey: machineHostKeyForWorktree(worktree, repo)
    }
  }, [repos, worktreeId, worktreesByRepo])
}

function useHostLabel(hostId: ExecutionHostId | null): string {
  return useAppStore((state) => {
    const parsed = parseExecutionHostId(hostId)
    switch (parsed?.kind) {
      case 'ssh':
        return state.sshTargetLabels.get(parsed.targetId) ?? parsed.targetId
      case 'runtime':
        return (
          state.runtimeEnvironments.find((environment) => environment.id === parsed.environmentId)
            ?.name ?? parsed.environmentId
        )
      case 'local':
      case undefined:
        return getLocalExecutionHostLabel(CLIENT_PLATFORM)
    }
  })
}

/**
 * Where this worktree runs, always shown at the right of its tab bar, Local Mac included. A
 * machine adds its state dot and opens the same actions as the sidebar.
 */
export function WorktreeLocationChip({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const { hostId, machineHostKey } = useWorktreeHostId(worktreeId)
  const machine = useMachineForHost(machineHostKey)
  const hostLabel = useHostLabel(hostId)
  if (machine) {
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs">
                <Box />
                <span className="max-w-32 truncate">{machine.machine.name}</span>
                <MachineStateDot state={getMachineDisplayState(machine.machine.state)} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {describeMachine(machine)}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <MachineMenuItems match={machine} />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  const parsed = parseExecutionHostId(hostId)
  return (
    <span className="inline-flex h-6 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      {parsed?.kind === 'ssh' || parsed?.kind === 'runtime' ? (
        <Server className="size-3" />
      ) : (
        <Monitor className="size-3" />
      )}
      <span className="max-w-32 truncate">{hostLabel}</span>
    </span>
  )
}
