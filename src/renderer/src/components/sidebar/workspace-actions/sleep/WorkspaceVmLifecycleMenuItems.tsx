import React from 'react'
import { Loader2, Moon, Play } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectEphemeralVmWorkspaceRuntime } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import {
  resumeEphemeralVmWorkspace,
  suspendEphemeralVmWorkspace
} from '@/lib/workspace/activation/sidebar-worktree-activation'
import type { EphemeralVmRuntimeStatus } from '../../../../../../shared/ephemeral-vm-runtimes'

export type WorkspaceVmLifecycleAction = 'suspend' | 'resume' | 'waking' | null

/** Which lifecycle entry a VM-backed workspace's menu offers; null hides the entry. */
export function getWorkspaceVmLifecycleAction(
  status: EphemeralVmRuntimeStatus | undefined,
  waking: boolean,
  canSuspend = true
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
      return canSuspend ? 'suspend' : null
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
 * How Suspend VM reaches the VM. It never suspends under live sessions: Sleep stops them and
 * then suspends the VM. With active children, this workspace sleeps with them (even idle), so
 * its VM suspends once their sessions have stopped.
 */
export function getVmSuspendRoute(args: {
  hasActiveDescendants: boolean
  hasSleepableActivity: boolean
}): 'sleep-subtree' | 'sleep' | 'suspend' {
  if (args.hasActiveDescendants) {
    return 'sleep-subtree'
  }
  return args.hasSleepableActivity ? 'sleep' : 'suspend'
}

/**
 * Suspend/Resume for a workspace that owns a VM, in place of its Sleep item. Sleep on a VM
 * workspace already stops its panels and then suspends the VM, so the two would be the same
 * action under two names; Suspend VM runs that Sleep, or suspends the VM directly when nothing
 * is open. `sleepItems` stay for workspaces without a suspendable VM, and beside the VM item
 * when they offer more (sleeping descendants). Mounted only inside the open menu, so idle rows
 * add no subscription.
 */
export function WorkspaceVmLifecycleMenuItems({
  worktreeId,
  hasSleepableActivity,
  disabled,
  onSleep,
  hasActiveDescendants,
  onSleepSubtree,
  sleepItems,
  replacesSleep
}: {
  worktreeId: string
  hasSleepableActivity: boolean
  disabled: boolean
  onSleep: () => void
  /** A child workspace with open panels may run on this VM; suspending must sleep it first. */
  hasActiveDescendants: boolean
  onSleepSubtree: () => void
  sleepItems: React.ReactNode
  /** False when Sleep offers more than this workspace (its descendants), so both stay. */
  replacesSleep: boolean
}): React.JSX.Element | null {
  const { status, canSuspend, waking } = useAppStore(
    useShallow((state) => {
      const runtime = selectEphemeralVmWorkspaceRuntime(state, worktreeId)
      return {
        status: runtime?.status,
        canSuspend: runtime?.canSuspend ?? true,
        waking: Boolean(state.wakingEphemeralVmWorkspaceIds[worktreeId])
      }
    })
  )
  const t = useTranslate()
  const action = getWorkspaceVmLifecycleAction(status, waking, canSuspend)
  if (!action) {
    return <>{sleepItems}</>
  }
  const vmItem = (
    <VmLifecycleMenuItem
      action={action}
      retry={status === 'resume_failed'}
      disabled={disabled}
      t={t}
      onResume={() => void resumeEphemeralVmWorkspace(worktreeId)}
      onSuspend={() => {
        const route = getVmSuspendRoute({ hasActiveDescendants, hasSleepableActivity })
        if (route === 'sleep-subtree') {
          onSleepSubtree()
        } else if (route === 'sleep') {
          onSleep()
        } else {
          void suspendEphemeralVmWorkspace(worktreeId)
        }
      }}
    />
  )
  // Sleep and Suspend VM are one action on a running VM. A VM still asleep or waking keeps Sleep
  // only while it has restored panels to close; otherwise Sleep would sit there disabled.
  return replacesSleep && (action === 'suspend' || !hasSleepableActivity) ? (
    vmItem
  ) : (
    <>
      {sleepItems}
      {vmItem}
    </>
  )
}

function VmLifecycleMenuItem({
  action,
  retry,
  disabled,
  t,
  onResume,
  onSuspend
}: {
  action: NonNullable<WorkspaceVmLifecycleAction>
  retry: boolean
  disabled: boolean
  t: Translate
  onResume: () => void
  onSuspend: () => void
}): React.JSX.Element {
  if (action === 'waking') {
    return (
      <DropdownMenuItem disabled>
        <Loader2 className="size-3.5 animate-spin" />
        {t('workspace.vm.menu.waking', 'Waking VM…')}
      </DropdownMenuItem>
    )
  }
  if (action === 'resume') {
    return (
      <DropdownMenuItem disabled={disabled} onSelect={onResume}>
        <Play className="size-3.5" />
        {retry
          ? t('workspace.vm.menu.retryResume', 'Retry Resume VM')
          : t('workspace.vm.menu.resume', 'Resume VM')}
      </DropdownMenuItem>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem disabled={disabled} onSelect={onSuspend}>
          <Moon className="size-3.5" />
          {t('workspace.vm.menu.suspend', 'Suspend VM')}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {t(
          'workspace.vm.menu.suspendDescription',
          "Close this workspace's panels and suspend its VM. Opening the workspace wakes it."
        )}
      </TooltipContent>
    </Tooltip>
  )
}
