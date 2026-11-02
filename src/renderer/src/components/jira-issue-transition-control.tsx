import { taskProviderErrorMessage, taskProviderErrorText } from '@/lib/task-provider-error-copy'
import { useState } from 'react'
import { ChevronDown, CircleAlert, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { classifyTransitionRequirements } from '../../../shared/jira/jira-transition-fields'
import { JiraTransitionFieldsForm } from './jira-transition-fields-form'
import type {
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraTransition
} from '../../../shared/jira/jira-types'
import { openAppHttpLink } from '@/lib/app-http-link-open'

type Props = {
  issue: JiraIssue
  transitions: JiraTransition[]
  loading: boolean
  error: string | null
  pending: boolean
  onRetry: () => void
  onTransition: (
    updates: JiraIssueUpdate,
    transition: JiraTransition
  ) => Promise<JiraMutationResult>
}

export function JiraIssueTransitionControl({
  issue,
  transitions,
  loading,
  error,
  pending,
  onRetry,
  onTransition
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<JiraTransition | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const requirement = selected ? classifyTransitionRequirements(selected) : null
  const busy = pending || loading

  function reset(): void {
    setSelected(null)
    setSubmitError(null)
  }

  async function apply(transition: JiraTransition, updates: JiraIssueUpdate): Promise<void> {
    setSubmitError(null)
    try {
      const result = await onTransition(updates, transition)
      if (result.ok) {
        setOpen(false)
        reset()
      } else {
        setSubmitError(taskProviderErrorMessage(result))
      }
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? taskProviderErrorText(error.message)
          : translate(
              'auto.components.JiraIssueWorkspace.ea21952aa3',
              'Failed to update Jira issue.'
            )
      )
    }
  }

  function choose(transition: JiraTransition): void {
    reset()
    const nextRequirement = classifyTransitionRequirements(transition)
    setSelected(transition)
    if (nextRequirement.kind === 'none') {
      void apply(transition, { transitionId: transition.id })
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) {
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) {
          reset()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          aria-label={translate('jira.transitions.changeStatus', 'Change status: {{status}}', {
            status: issue.status.name
          })}
          aria-invalid={Boolean(error)}
          disabled={pending}
        >
          {issue.status.name}
          {loading || pending ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          ) : error ? (
            <CircleAlert className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start" wheelScroll>
        <div className="scrollbar-sleek max-h-96 space-y-3 overflow-y-auto p-3">
          {error ? (
            <>
              <p className="text-xs text-destructive" role="alert">
                {translate('jira.transitions.loadError', 'Could not load status changes.')} {error}
              </p>
              <Button variant="secondary" size="sm" onClick={onRetry} disabled={loading}>
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            </>
          ) : loading ? (
            <p className="text-xs text-muted-foreground" role="status">
              {translate('jira.transitions.loading', 'Loading status changes…')}
            </p>
          ) : null}
          {requirement?.kind === 'form' && selected ? (
            <JiraTransitionFieldsForm
              transition={selected}
              pending={busy || Boolean(error)}
              onBack={reset}
              onSubmit={(updates) => apply(selected, updates)}
            />
          ) : error || loading ? null : requirement?.kind === 'unsupported' ? (
            <>
              <p className="text-sm font-medium">
                {translate('jira.transitions.completeInJira', 'Complete “{{name}}” in Jira', {
                  name: selected?.name
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'jira.transitions.unsupported',
                  'Jira requires fields Orca cannot collect yet: {{fields}}.',
                  { fields: requirement.fields.map((field) => field.name).join(', ') }
                )}
              </p>
            </>
          ) : selected && submitError ? null : transitions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('jira.transitions.empty', 'No status changes available.')}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {transitions.map((transition) => (
                <Button
                  key={transition.id}
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => choose(transition)}
                >
                  {transition.name}
                </Button>
              ))}
            </div>
          )}
          {submitError ? (
            <p role="alert" className="text-xs text-destructive">
              {submitError}
            </p>
          ) : null}
          {requirement?.kind === 'unsupported' || submitError ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
                {translate('jira.transitions.back', 'Back')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={(event) => openAppHttpLink(issue.url, { event })}
              >
                <ExternalLink className="size-3" />
                {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
