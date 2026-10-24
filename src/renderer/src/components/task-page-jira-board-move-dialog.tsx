import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { JiraTransitionFieldsForm } from './jira-transition-fields-form'
import { classifyTransitionRequirements } from '../../../shared/jira/jira-transition-fields'
import type { JiraIssue, JiraIssueUpdate, JiraTransition } from '../../../shared/jira/jira-types'

export type JiraBoardMovePrompt = {
  issue: JiraIssue
  destination: string
  transitions: JiraTransition[]
  selected: JiraTransition | null
  error: string | null
  loading: boolean
}

type Props = {
  prompt: JiraBoardMovePrompt | null
  pending: boolean
  onClose: () => void
  onChoose: (transition: JiraTransition) => void
  onSubmit: (updates: JiraIssueUpdate) => Promise<void>
  onRetry: () => void
}

export function JiraBoardMoveDialog({
  prompt,
  pending,
  onClose,
  onChoose,
  onSubmit,
  onRetry
}: Props): React.JSX.Element {
  const requirement = prompt?.selected ? classifyTransitionRequirements(prompt.selected) : null
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('jira.board.moveTitle', 'Move {{key}} to {{column}}', {
              key: prompt?.issue.key,
              column: prompt?.destination
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'jira.board.moveDescription',
              'Jira controls which status changes are available and which fields they require.'
            )}
          </DialogDescription>
        </DialogHeader>
        {prompt?.loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {translate('jira.transitions.loading', 'Loading status changes…')}
          </p>
        ) : null}
        {prompt?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {prompt.error}
          </p>
        ) : null}
        {!prompt?.selected && !prompt?.loading && prompt?.transitions.length ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {translate('jira.board.chooseTransition', 'Choose a status change:')}
            </p>
            {prompt.transitions.map((transition) => (
              <Button
                key={transition.id}
                variant="secondary"
                disabled={pending}
                onClick={() => onChoose(transition)}
              >
                {transition.name}
              </Button>
            ))}
          </div>
        ) : null}
        {requirement?.kind === 'unsupported' ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'jira.transitions.unsupported',
              'Jira requires fields Orca cannot collect yet: {{fields}}.',
              { fields: requirement.fields.map((field) => field.name).join(', ') }
            )}
          </p>
        ) : null}
        {requirement?.kind === 'form' && prompt?.selected ? (
          <JiraTransitionFieldsForm
            key={prompt.selected.id}
            transition={prompt.selected}
            pending={pending}
            onBack={onClose}
            onSubmit={onSubmit}
          />
        ) : null}
        {prompt && (prompt.error || requirement?.kind === 'unsupported') ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              {translate('jira.board.cancel', 'Cancel')}
            </Button>
            {requirement?.kind === 'none' ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (prompt?.selected) {
                    onChoose(prompt.selected)
                  }
                }}
              >
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            ) : !prompt.selected && prompt.transitions.length === 0 ? (
              <Button variant="secondary" disabled={pending || prompt.loading} onClick={onRetry}>
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                if (prompt) {
                  void window.api.shell.openUrl(prompt.issue.url)
                }
              }}
            >
              <ExternalLink />
              {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
