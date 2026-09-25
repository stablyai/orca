import { useId, useMemo, useRef } from 'react'
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
import type { AgentSessionForkStage } from '@/lib/agent-session-fork-flow'
import {
  parseAgentSessionForkModalData,
  type AgentSessionForkModalData
} from './agent-session-fork-modal-data'
import {
  useAgentSessionForkDialogState,
  type AgentSessionForkCarryAvailability
} from './use-agent-session-fork-dialog-state'
import { AgentSessionForkSessionField } from './AgentSessionForkSessionField'
import { AgentSessionForkAdvancedFields } from './AgentSessionForkAdvancedFields'

function stageLabel(stage: AgentSessionForkStage): string {
  switch (stage) {
    case 'creating':
      return translate('components.agentSessionFork.stage.creating', 'Creating worktree…')
    case 'carrying':
      return translate('components.agentSessionFork.stage.carrying', 'Bringing changes…')
    case 'launching':
      return translate('components.agentSessionFork.stage.launching', 'Starting agent…')
  }
}

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

function AgentSessionForkDialogBody({
  data
}: {
  data: AgentSessionForkModalData
}): React.JSX.Element {
  const state = useAgentSessionForkDialogState(data)
  const nameId = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const { source } = state
  const workspace = source.label

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
            {translate(
              'components.agentSessionFork.description',
              'Start a new branch from {{workspace}} and continue the conversation there.',
              { workspace }
            )}
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
            label={translate(
              'components.agentSessionFork.asChild',
              'Create as a child of {{workspace}}',
              { workspace }
            )}
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
              description={carryDescription(state.carryAvailability, workspace)}
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
              baseBranch={state.baseBranchOverride}
              parentBranch={source.parentBranch}
              onBaseBranchChange={state.setBaseBranchOverride}
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
            {state.selectedOption.kind === 'transcript' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void state.copyContext()}
                disabled={state.busy}
              >
                {translate('components.agentSessionFork.copyContext', 'Copy Context')}
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
                disabled={state.busy}
              >
                {translate('components.agentSessionFork.cancel', 'Cancel')}
              </Button>
              {/* Why: fixed width so the stage labels don't resize the button mid-fork. */}
              <Button
                type="submit"
                size="sm"
                className="w-40"
                disabled={state.busy || state.nameInvalid}
              >
                {state.visibleStage ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span className="truncate">{stageLabel(state.visibleStage)}</span>
                  </>
                ) : (
                  translate('components.agentSessionFork.submit', 'Create Fork')
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
