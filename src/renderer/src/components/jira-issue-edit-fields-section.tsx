import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { JiraEditField, JiraIssueUpdate } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { JiraIssueEditFieldControl } from './jira-issue-edit-field-control'
import { getJiraEditFieldDisplay, getJiraEditFieldEditor } from './jira-issue-edit-field-drafts'
import type { JiraIssueEditFieldsState } from './use-jira-issue-edit-fields'

/** The pending-field id `mutateIssue` uses for an edit-screen field. */
export function jiraEditFieldPendingId(field: JiraEditField): string {
  return `field:${field.key}`
}

export function JiraIssueEditFieldsSection({
  state,
  pendingField,
  owner,
  siteId,
  onSave
}: {
  state: JiraIssueEditFieldsState
  pendingField: string | null
  owner: RuntimeClientTarget
  siteId?: string
  onSave: (field: JiraEditField, update: JiraIssueUpdate) => Promise<boolean>
}): React.JSX.Element | null {
  const { fields, loading, error, reload } = state
  // Description has its own editor; empty read-only fields are noise.
  const visible = (fields ?? []).filter(
    (field) =>
      field.key !== 'description' &&
      (getJiraEditFieldEditor(field) !== 'readonly' || getJiraEditFieldDisplay(field) !== '')
  )
  if (!error && visible.length === 0 && !(loading && fields === null)) {
    return null
  }

  return (
    <section className="border-b border-border/40 px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">
          {translate('jira.editFields.title', 'Fields')}
        </span>
        {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        {error && !loading ? (
          <Button variant="outline" size="xs" onClick={() => void reload()}>
            <RefreshCw className="size-3" />
            {translate('jira.editFields.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((field) => (
            <JiraIssueEditFieldControl
              key={`${field.key}:${JSON.stringify(field.value)}`}
              field={field}
              pending={pendingField === jiraEditFieldPendingId(field)}
              disabled={pendingField !== null}
              owner={owner}
              siteId={siteId}
              onSave={onSave}
            />
          ))}
        </div>
      )}
    </section>
  )
}
