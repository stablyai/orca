import React from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { MachineProviderKey } from '../../../../shared/machine-inventory'
import { checkCreateOutcome } from '@/lib/machines/machine-start'
import { describeMachineFailure } from '@/lib/machines/machine-copy'

type LeftoverMachine = { id: string; name: string }

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'found'; machine: LeftoverMachine; error?: string }
  | { kind: 'deleting'; machine: LeftoverMachine }
  | { kind: 'deleted' }

/**
 * After a canceled create, the provider may still have made the machine. This looks it up by the
 * create's operation id and offers to delete it. A machine the create already reported is offered
 * for deletion at once; nothing claims "none" until the provider has said so.
 */
export default function MachineLeftoverCheck({
  providerKey,
  providerName,
  operationId,
  knownMachine,
  onDeleted,
  trailing
}: {
  providerKey: MachineProviderKey
  providerName: string
  operationId: string
  /** Set when the create had already returned the machine before Cancel. */
  knownMachine: LeftoverMachine | null
  onDeleted: () => void
  /** Shown beside the check's own action, e.g. Remove worktree. */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const [state, setState] = React.useState<CheckState>(() =>
    knownMachine ? { kind: 'found', machine: knownMachine } : { kind: 'idle' }
  )

  const check = async (): Promise<void> => {
    setState({ kind: 'checking' })
    const outcome = await checkCreateOutcome(providerKey, operationId)
    switch (outcome.kind) {
      case 'found':
        setState({ kind: 'found', machine: outcome.machine })
        return
      case 'pending':
      case 'none':
      case 'unknown':
        setState({ kind: outcome.kind })
    }
  }

  const remove = async (machine: LeftoverMachine): Promise<void> => {
    setState({ kind: 'deleting', machine })
    const deleted = await window.api.machines.delete({ providerKey, machineId: machine.id })
    // Why: main answers with the machine as the provider left it; only `gone` means it went.
    const gone = deleted.ok && deleted.value.state === 'gone'
    if (gone) {
      onDeleted()
    }
    setState(
      gone
        ? { kind: 'deleted' }
        : {
            kind: 'found',
            machine,
            error: deleted.ok
              ? translate(
                  'auto.components.worktreeCreation.MachineLeftoverCheck.stillThere',
                  'The provider still lists it. Try again in a minute.'
                )
              : describeMachineFailure(deleted.code)
          }
    )
  }

  const checkButton = (label: string): React.ReactNode => (
    <Button
      variant="outline"
      size="sm"
      disabled={state.kind === 'checking'}
      onClick={() => void check()}
    >
      {label}
    </Button>
  )
  const checkAgain = translate(
    'auto.components.worktree.creation.MachineLeftoverCheck.checkAgain',
    'Check again'
  )
  const view = ((): { message: string | null; failed?: boolean; action: React.ReactNode } => {
    switch (state.kind) {
      case 'idle':
      case 'checking':
        return {
          message: null,
          action: checkButton(
            translate(
              'auto.components.worktree.creation.MachineLeftoverCheck.check',
              'Check for a leftover machine'
            )
          )
        }
      case 'pending':
        return {
          message: translate(
            'auto.components.worktree.creation.MachineLeftoverCheck.notFoundYet',
            'Nothing found yet.'
          ),
          action: checkButton(checkAgain)
        }
      case 'unknown':
        return {
          message: translate(
            'auto.components.worktree.creation.MachineLeftoverCheck.unknown',
            'Couldn’t reach {{provider}} to check.',
            { provider: providerName }
          ),
          action: checkButton(checkAgain)
        }
      case 'none':
        return {
          message: translate(
            'auto.components.worktree.creation.MachineLeftoverCheck.none',
            'No leftover machine'
          ),
          action: null
        }
      case 'found':
      case 'deleting':
        return {
          message:
            state.kind === 'found' && state.error
              ? translate(
                  'auto.components.worktree.creation.MachineLeftoverCheck.deleteFailed',
                  'Couldn’t delete it. {{reason}}',
                  { reason: state.error }
                )
              : null,
          failed: true,
          action: (
            <Button
              variant="outline"
              size="sm"
              disabled={state.kind === 'deleting'}
              onClick={() => void remove(state.machine)}
            >
              {translate(
                'auto.components.worktree.creation.MachineLeftoverCheck.delete',
                'Delete {{name}}',
                { name: state.machine.name }
              )}
            </Button>
          )
        }
      case 'deleted':
        return {
          message: translate(
            'auto.components.worktree.creation.MachineLeftoverCheck.deleted',
            'Leftover machine deleted'
          ),
          action: null
        }
    }
  })()

  // Why: the result reads as its own line above the actions, never squeezed between buttons.
  return (
    <div className="flex w-full flex-col items-start gap-2">
      {view.message ? (
        <p
          data-failed={view.failed === true}
          className="text-xs text-muted-foreground data-[failed=true]:text-destructive"
        >
          {view.message}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {view.action}
        {trailing}
      </div>
    </div>
  )
}
