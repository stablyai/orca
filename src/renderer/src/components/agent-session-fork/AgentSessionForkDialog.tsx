import { useEffect, useId, useMemo, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSwitchRow } from '@/components/settings/SettingsFormControls'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  parseAgentSessionForkModalData,
  type AgentSessionForkModalData
} from './agent-session-fork-modal-data'
import { useAgentSessionForkDialogState } from './use-agent-session-fork-dialog-state'
import { agentSessionForkStageLabel } from './agent-session-fork-progress-toast'
import type { AgentSessionForkCarryAvailability } from './agent-session-fork-parent-probe'
import { AgentSessionForkSessionField } from './AgentSessionForkSessionField'
import { AgentSessionForkAdvancedFields } from './AgentSessionForkAdvancedFields'

function carryDescription(
  availability: AgentSessionForkCarryAvailability,
  workspace: string
): string {
  if (availability === 'other-base') {
    return translate(
      'components.agentSessionFork.carryOtherBase',
      'Only available when starting from the current commit of {{workspace}}.',
      { workspace }
    )
  }
  if (availability === 'unsupported') {
    return translate(
      'components.agentSessionFork.carryUnsupported',
      'This host does not support bringing changes.'
    )
  }
  return translate('components.agentSessionFork.carryStagingNote', 'Staging is not preserved.')
}

function forkDescription(withAgent: boolean, fromParent: boolean, workspace: string): string {
  if (!fromParent) {
    return withAgent
      ? translate(
          'components.agentSessionFork.descriptionOtherBase',
          'Start a new branch and continue the conversation there.'
        )
      : translate('components.agentSessionFork.descriptionNoAgentOtherBase', 'Start a new branch.')
  }
  return withAgent
    ? translate(
        'components.agentSessionFork.description',
        'Start a new branch from {{workspace}} and continue the conversation there.',
        { workspace }
      )
    : translate(
        'components.agentSessionFork.descriptionNoAgent',
        'Start a new branch from {{workspace}}.',
        { workspace }
      )
}

function AgentSessionForkDialogBody({
  data
}: {
  data: AgentSessionForkModalData
}): React.JSX.Element {
  const state = useAgentSessionForkDialogState(data)
  const nameId = useId()
  const carryDescriptionId = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const { source } = state
  const workspace = source.label
  const asChildLabel = translate(
    'components.agentSessionFork.asChild',
    'Create as a child of {{workspace}}',
    { workspace }
  )

  useEffect(() => {
    // Why: the submit button that held focus is disabled while busy, so focus must return to the form.
    if (state.error) {
      nameInputRef.current?.focus()
    }
  }, [state.error])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          state.close()
        }
      }}
    >
      <DialogContent
        className="max-w-md sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          nameInputRef.current?.focus()
          nameInputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('components.agentSessionFork.title', 'Fork Agent Session')}
          </DialogTitle>
          <DialogDescription>
            {/* Why: workspace names can be one long unbroken token. */}
            <span className="break-words">
              {forkDescription(
                state.selectedOption.kind !== 'none',
                state.base.kind === 'parent-commit',
                workspace
              )}
            </span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void state.submit()
          }}
        >
          {state.showSessionField ? (
            <AgentSessionForkSessionField
              options={state.options}
              value={state.selectedKey}
              onValueChange={state.setSelectedKey}
              disabled={state.busy}
            />
          ) : null}
          <div className="space-y-1">
            <Label htmlFor={nameId}>{translate('components.agentSessionFork.name', 'Name')}</Label>
            <Input
              id={nameId}
              ref={nameInputRef}
              value={state.name}
              onChange={(event) => state.setName(event.target.value)}
              aria-invalid={state.nameInvalid || undefined}
              disabled={state.busy}
            />
          </div>
          <SettingsSwitchRow
            label={<span className="min-w-0 leading-snug break-words">{asChildLabel}</span>}
            ariaLabel={asChildLabel}
            checked={state.asChild}
            onChange={() => state.setAsChild((value) => !value)}
            disabled={state.busy}
          />
          {state.carryAvailability !== 'hidden' ? (
            <SettingsSwitchRow
              label={translate(
                'components.agentSessionFork.carryChanges',
                'Bring uncommitted changes ({{modified}} modified, {{added}} new)',
                { modified: state.modifiedCount, added: state.newCount }
              )}
              description={
                <span className="break-words">
                  {carryDescription(state.carryAvailability, workspace)}
                </span>
              }
              descriptionId={carryDescriptionId}
              checked={state.carryChanges && state.carryAvailability === 'available'}
              onChange={() => state.setCarryChanges((value) => !value)}
              disabled={state.carryAvailability !== 'available' || state.busy}
            />
          ) : null}
          {source.worktree ? (
            <AgentSessionForkAdvancedFields
              open={state.advancedOpen}
              onOpenChange={state.setAdvancedOpen}
              repoId={source.worktree.repoId}
              base={state.base}
              parentBranch={source.parentBranch}
              parentCommit={state.parentCommitShort}
              workspace={workspace}
              onBaseChange={state.setBase}
              disabled={state.busy}
            />
          ) : null}
          {state.selectedOption.kind === 'transcript' ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'components.agentSessionFork.transcriptNotice',
                'This agent will get the transcript as a draft instead of the conversation history.'
              )}
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-xs text-destructive">
              {state.error}
            </p>
          ) : null}
          <DialogFooter className="sm:justify-between">
            {state.canCopyContext ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void state.copyContext()}
                disabled={state.busy}
              >
                {translate('components.agentSessionFork.copyContext', 'Copy context')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={state.close}
                disabled={state.flowRunning}
              >
                {translate('components.agentSessionFork.cancel', 'Cancel')}
              </Button>
              {/* Why: reserves the longest English stage label so the busy swap never shrinks it. */}
              <Button
                type="submit"
                size="sm"
                className="min-w-48"
                disabled={state.busy || state.nameInvalid}
              >
                {state.visibleStage ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {agentSessionForkStageLabel(state.visibleStage)}
                  </>
                ) : (
                  translate('components.agentSessionFork.submit', 'Create fork')
                )}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function AgentSessionForkDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const data = useMemo(
    () => (activeModal === 'agent-session-fork' ? parseAgentSessionForkModalData(modalData) : null),
    [activeModal, modalData]
  )
  if (!data) {
    return null
  }
  // Why: a new source remounts the body so every field reseeds from that workspace.
  return <AgentSessionForkDialogBody key={data.sourceWorktreeId} data={data} />
}
