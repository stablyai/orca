import React from 'react'
import { Check, ChevronDown, ChevronUp, CircleAlert, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { getMachineCreationStages, type MachineStage } from '@/lib/machines/machine-creation-stages'
import { cancelMachineCreation } from '@/lib/machines/machine-creation-cancel'
import { formatMachineExpiryInline, getMachineLifetimeLabel } from '@/lib/machines/machine-copy'
import { useAppStore } from '@/store'
import CreationOutputLog from './CreationOutputLog'
import MachineLeftoverCheck from './MachineLeftoverCheck'

function StageIcon({ state }: { state: MachineStage['state'] }): React.JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="size-4 text-foreground" />
    case 'active':
      return <LoadingSpinner className="size-4 text-muted-foreground" />
    case 'failed':
      return <CircleAlert className="size-4 text-destructive" />
    case 'stopped':
      return <X className="size-4 text-muted-foreground" />
    case 'pending':
      return <span className="size-2 rounded-full ring-1 ring-inset ring-muted-foreground" />
  }
}

function describeCreateLifetime(
  create: { lifetime: 'persistent' | 'temporary'; ttlSeconds?: number },
  startedAt: number
): string {
  const label = getMachineLifetimeLabel(create.lifetime)
  return create.lifetime === 'temporary' && create.ttlSeconds
    ? `${label} · ${formatMachineExpiryInline(startedAt + create.ttlSeconds * 1000)}`
    : label
}

/** Where the worktree is going: the machine and provider, and for a new machine its lifetime. */
function statusDetail(args: {
  entry: PendingWorktreeCreation
  providerName: string | undefined
  canceled: boolean
  leftoverDeleted: boolean
}): string {
  const machine = args.entry.request.machine
  if (!machine) {
    return ''
  }
  const provider = args.providerName ?? ''
  if (args.canceled) {
    if (args.leftoverDeleted) {
      return translate(
        'auto.components.worktree.creation.MachineCreationStatus.canceledDeleted',
        'The machine this create left behind was deleted.'
      )
    }
    // Why: once the create returned, the machine is known to exist; say so plainly.
    return machine.create && machine.machineId
      ? translate(
          'auto.components.worktree.creation.MachineCreationStatus.canceledCreated',
          '{{machine}} was already created on {{provider}} and is still running.',
          { machine: machine.machineName, provider }
        )
      : translate(
          'auto.components.worktree.creation.MachineCreationStatus.canceledDetail',
          '{{provider}} may have started a machine before you canceled.',
          { provider }
        )
  }
  if (machine.create) {
    const where = translate(
      'auto.components.worktree.creation.MachineCreationStatus.newMachineOn',
      'New machine {{machine}} on {{provider}}',
      { machine: machine.machineName, provider }
    )
    return `${where} · ${describeCreateLifetime(machine.create, args.entry.startedAt)}`
  }
  return provider
    ? translate(
        'auto.components.worktree.creation.MachineCreationStatus.machineOn',
        '{{machine}} on {{provider}}',
        { machine: machine.machineName, provider }
      )
    : machine.machineName
}

function statusTitle(failed: boolean, canceled: boolean, name: string): string {
  if (canceled) {
    return translate('auto.components.worktree.creation.MachineCreationStatus.canceled', 'Canceled')
  }
  return failed
    ? translate(
        'auto.components.worktree.creation.MachineCreationStatus.failedTitle',
        'Couldn’t set up {{name}}',
        { name }
      )
    : translate(
        'auto.components.worktree.creation.MachineCreationStatus.title',
        'Setting up {{name}}',
        { name }
      )
}

/**
 * In-pane progress for a worktree on a machine: three stages, the provider's log behind
 * "Show log", and Retry when a stage failed. The composer closed long ago.
 */
export default function MachineCreationStatus({
  entry,
  onRetry,
  onRemove
}: {
  entry: PendingWorktreeCreation
  onRetry: () => void
  onRemove: () => void
}): React.JSX.Element {
  const machine = entry.request.machine
  const providerName = useAppStore((state) =>
    machine ? state.machineProviders[machine.providerKey]?.name : undefined
  )
  const [logOpen, setLogOpen] = React.useState(false)
  const projectName = useAppStore((state) =>
    machine
      ? (state.projects.find((project) => project.id === machine.projectId)?.displayName ?? null)
      : null
  )
  const stages = getMachineCreationStages(entry, projectName)
  const canceled = entry.machineProgress?.canceled === true
  const leftoverDeleted = entry.machineProgress?.leftoverDeleted === true
  const failed = entry.status === 'error' && !canceled
  const startingMachine = stages[0].state === 'active'
  const name = entry.request.displayName || entry.request.name

  const removeButton = (
    <Button variant="ghost" size="sm" onClick={onRemove}>
      {translate(
        'auto.components.worktree.creation.MachineCreationStatus.removeWorktree',
        'Remove worktree'
      )}
    </Button>
  )

  return (
    <div className="flex min-h-full justify-center pt-12">
      <div className="w-full max-w-md">
        <div className="text-sm font-medium text-foreground">
          {statusTitle(failed, canceled, name)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {statusDetail({ entry, providerName, canceled, leftoverDeleted })}
        </div>
        <ol data-machine-stages="" className="mt-5">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              data-stage={stage.id}
              data-state={stage.state}
              className="group relative grid min-h-8.5 grid-cols-[20px_1fr_auto] gap-x-3 text-sm"
            >
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-2.5 top-5.5 w-px -translate-x-1/2 bg-border"
                />
              ) : null}
              <span className="relative flex size-5 items-center justify-center">
                <StageIcon state={stage.state} />
              </span>
              <span className="leading-5 group-data-[state=failed]:text-destructive group-data-[state=pending]:text-muted-foreground group-data-[state=stopped]:text-muted-foreground">
                {stage.label}
              </span>
              <span className="text-right text-xs leading-5 tabular-nums text-muted-foreground">
                {stage.detail}
              </span>
              {stage.state === 'failed' && entry.error ? (
                <p className="col-start-2 col-end-4 mb-2.5 text-xs leading-5 text-muted-foreground">
                  {entry.error}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        <Collapsible open={logOpen} onOpenChange={setLogOpen} className="ml-8 mt-4">
          <div className="flex items-center gap-2">
            {failed ? (
              <>
                <Button size="sm" onClick={onRetry}>
                  <RotateCcw />
                  {translate(
                    'auto.components.worktree.creation.MachineCreationStatus.retry',
                    'Retry'
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={onRemove}>
                  {translate(
                    'auto.components.worktree.creation.MachineCreationStatus.removeWorktree',
                    'Remove worktree'
                  )}
                </Button>
              </>
            ) : null}
            {canceled ? (
              machine?.create ? (
                <MachineLeftoverCheck
                  providerKey={machine.providerKey}
                  providerName={providerName ?? ''}
                  operationId={machine.create.operationId}
                  onDeleted={() =>
                    useAppStore.getState().updatePendingWorktreeCreation(entry.creationId, {
                      machineProgress: {
                        activity: entry.machineProgress?.activity ?? 'creating',
                        canceled: true,
                        leftoverDeleted: true
                      }
                    })
                  }
                  knownMachine={
                    machine.machineId ? { id: machine.machineId, name: machine.machineName } : null
                  }
                  trailing={removeButton}
                />
              ) : (
                removeButton
              )
            ) : (
              <>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="xs">
                    {translate(
                      'auto.components.worktree.creation.MachineCreationStatus.showLog',
                      'Show log'
                    )}
                    {logOpen ? <ChevronUp /> : <ChevronDown />}
                  </Button>
                </CollapsibleTrigger>
                {startingMachine ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void cancelMachineCreation(entry.creationId)}
                  >
                    {translate(
                      'auto.components.worktree.creation.MachineCreationStatus.cancel',
                      'Cancel'
                    )}
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <CollapsibleContent className="mt-2.5">
            <CreationOutputLog
              size="compact"
              log={entry.provisioningLog ?? ''}
              emptyLabel={translate(
                'auto.components.worktree.creation.MachineCreationStatus.logEmpty',
                'Waiting for provider output…'
              )}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
