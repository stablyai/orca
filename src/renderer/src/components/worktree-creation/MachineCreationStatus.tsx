import React from 'react'
import { Check, ChevronDown, ChevronUp, CircleAlert, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { getMachineCreationStages, type MachineStage } from '@/lib/machines/machine-creation-stages'
import { useAppStore } from '@/store'
import CreationOutputLog from './CreationOutputLog'

function StageIcon({ state }: { state: MachineStage['state'] }): React.JSX.Element {
  switch (state) {
    case 'done':
      return <Check className="size-4 text-foreground" />
    case 'active':
      return <LoadingSpinner className="size-4 text-muted-foreground" />
    case 'failed':
      return <CircleAlert className="size-4 text-destructive" />
    case 'pending':
      return <span className="size-2 rounded-full ring-1 ring-inset ring-muted-foreground" />
  }
}

function statusTitle(failed: boolean, name: string): string {
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
  const stages = getMachineCreationStages(entry)
  const failed = entry.status === 'error'
  const name = entry.request.displayName || entry.request.name

  return (
    <div className="flex min-h-full justify-center pt-12">
      <div className="w-full max-w-md">
        <div className="text-sm font-medium text-foreground">{statusTitle(failed, name)}</div>
        {machine ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {providerName
              ? translate(
                  'auto.components.worktree.creation.MachineCreationStatus.machineOn',
                  '{{machine}} on {{provider}}',
                  { machine: machine.machineName, provider: providerName }
                )
              : machine.machineName}
          </div>
        ) : null}
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
              <span className="leading-5 group-data-[state=failed]:text-destructive group-data-[state=pending]:text-muted-foreground">
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
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs">
                {translate(
                  'auto.components.worktree.creation.MachineCreationStatus.showLog',
                  'Show log'
                )}
                {logOpen ? <ChevronUp /> : <ChevronDown />}
              </Button>
            </CollapsibleTrigger>
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
