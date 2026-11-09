import React from 'react'
import { AlertTriangle, Loader2, Moon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import type { EphemeralVmFailure } from '../../../../../../shared/ephemeral-vm-failure-copy'
import type { ExecutionHostVmState } from '../../../../../../shared/execution-host/execution-host-health'

export function getVmStateLabel(state: ExecutionHostVmState, t: Translate = translate): string {
  switch (state) {
    case 'provisioning':
      return t('workspace.vm.state.provisioning', 'VM provisioning')
    case 'suspended':
      return t('workspace.vm.state.suspended', 'VM suspended')
    case 'waking':
      return t('workspace.vm.state.waking', 'VM waking')
    case 'resume_failed':
      return t('workspace.vm.state.resumeFailed', 'VM resume failed')
    case 'provision_failed':
      return t('workspace.vm.state.provisionFailed', 'VM setup failed')
  }
}

function getVmStateHint(state: ExecutionHostVmState, t: Translate): string {
  switch (state) {
    case 'provisioning':
      return t('workspace.vm.hint.provisioning', 'The VM is being created.')
    case 'suspended':
      return t(
        'workspace.vm.hint.suspended',
        'Asleep to save cost. Opening the workspace wakes it.'
      )
    case 'waking':
      return t('workspace.vm.hint.waking', 'Resuming the VM and reconnecting.')
    case 'resume_failed':
      return t(
        'workspace.vm.hint.resumeFailed',
        'The VM could not be resumed. Right-click and choose Resume VM to retry.'
      )
    case 'provision_failed':
      return t(
        'workspace.vm.hint.provisionFailed',
        'The VM was not created, or creation was interrupted. Open Settings to destroy or remove it.'
      )
  }
}

export function VmStateTooltipBody({
  state,
  failure
}: {
  state: ExecutionHostVmState
  failure?: EphemeralVmFailure | null
}): React.JSX.Element {
  const t = useTranslate()
  const failureText =
    (state === 'resume_failed' || state === 'provision_failed') && failure
      ? ephemeralVmErrorText(failure)
      : null
  return (
    <>
      <div className="font-medium">{getVmStateLabel(state, t)}</div>
      {failureText ? <div className="text-destructive">{failureText}</div> : null}
      <div className="text-muted-foreground">{getVmStateHint(state, t)}</div>
    </>
  )
}

const iconClassName = 'size-[13px]'

export function VmStateIcon({
  state,
  sizeClassName = iconClassName
}: {
  state: ExecutionHostVmState
  sizeClassName?: string
}): React.JSX.Element {
  switch (state) {
    case 'suspended':
      return <Moon className={cn(sizeClassName, 'text-muted-foreground')} aria-hidden="true" />
    case 'provisioning':
    case 'waking':
      return (
        <Loader2
          className={cn(sizeClassName, 'animate-spin text-muted-foreground')}
          aria-hidden="true"
        />
      )
    case 'resume_failed':
    case 'provision_failed':
      return <AlertTriangle className={cn(sizeClassName, 'text-destructive')} aria-hidden="true" />
  }
}

/** Status-lane badge for VM-backed workspaces; the VM state outranks activity it makes impossible. */
export function WorktreeCardVmStateBadge({
  state,
  failure,
  className
}: {
  state: ExecutionHostVmState
  /** Shown above the hint so the row says why resume or setup failed. */
  failure?: EphemeralVmFailure | null
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const label = getVmStateLabel(state, t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-worktree-vm-state={state}
          className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}
        >
          <VmStateIcon state={state} />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        <VmStateTooltipBody state={state} failure={failure} />
      </TooltipContent>
    </Tooltip>
  )
}
