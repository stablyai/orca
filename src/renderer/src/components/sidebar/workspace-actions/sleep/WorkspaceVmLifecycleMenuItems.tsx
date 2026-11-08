import React from 'react'
import { Loader2, Moon, Play } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectEphemeralVmWorkspaceRuntime } from '@/store/slices/ephemeral-vm-lifecycle'
import {
  resumeEphemeralVmWorkspace,
  suspendEphemeralVmWorkspace
} from '@/lib/sidebar-worktree-activation'
import type { EphemeralVmRuntimeStatus } from '../../../../../../shared/ephemeral-vm-runtimes'

export type WorkspaceVmLifecycleAction = 'suspend' | 'resume' | 'waking' | null

/** Which lifecycle entry a VM-backed workspace's menu offers; null hides the entry. */
export function getWorkspaceVmLifecycleAction(
  status: EphemeralVmRuntimeStatus | undefined,
  waking: boolean
): WorkspaceVmLifecycleAction {
  if (!status) {
    return null
  }
  if (waking) {
    return 'waking'
  }
  switch (status) {
    case 'running':
    case 'suspend_failed':
      return 'suspend'
    case 'suspended':
    case 'resume_failed':
      return 'resume'
    case 'provisioning':
    case 'failed':
    case 'cleanup_pending':
    case 'cleanup_failed':
    case 'cleaned':
      return null
  }
}

/**
 * Suspend/Resume for a workspace that owns a VM. Mounted only inside the open menu, so idle
 * rows add no subscription. Suspending with open panels goes through Sleep, which stops them
 * before suspending the VM.
 */
export function WorkspaceVmLifecycleMenuItems({
  worktreeId,
  hasSleepableActivity,
  disabled,
  onSleep
}: {
  worktreeId: string
  hasSleepableActivity: boolean
  disabled: boolean
  onSleep: () => void
}): React.JSX.Element | null {
  const status = useAppStore(
    (state) => selectEphemeralVmWorkspaceRuntime(state, worktreeId)?.status
  )
  const waking = useAppStore((state) => Boolean(state.wakingEphemeralVmWorkspaceIds[worktreeId]))
  const action = getWorkspaceVmLifecycleAction(status, waking)
  if (action === 'waking') {
    return (
      <DropdownMenuItem disabled>
        <Loader2 className="size-3.5 animate-spin" />
        {translate('workspace.vm.menu.waking', 'Waking VM…')}
      </DropdownMenuItem>
    )
  }
  if (action === 'resume') {
    return (
      <DropdownMenuItem
        disabled={disabled}
        onSelect={() => void resumeEphemeralVmWorkspace(worktreeId)}
      >
        <Play className="size-3.5" />
        {status === 'resume_failed'
          ? translate('workspace.vm.menu.retryResume', 'Retry Resume VM')
          : translate('workspace.vm.menu.resume', 'Resume VM')}
      </DropdownMenuItem>
    )
  }
  if (action === 'suspend') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            disabled={disabled}
            onSelect={() =>
              hasSleepableActivity ? onSleep() : void suspendEphemeralVmWorkspace(worktreeId)
            }
          >
            <Moon className="size-3.5" />
            {translate('workspace.vm.menu.suspend', 'Suspend VM')}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="max-w-[220px] text-pretty">
          {translate(
            'workspace.vm.menu.suspendDescription',
            "Close this workspace's panels and suspend its VM. Opening the workspace wakes it."
          )}
        </TooltipContent>
      </Tooltip>
    )
  }
  return null
}
