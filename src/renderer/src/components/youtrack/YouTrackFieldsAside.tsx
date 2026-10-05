import { useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  YouTrackFieldSchema,
  YouTrackIssue,
  YouTrackFieldValue
} from '../../../../shared/youtrack-types'
import { YouTrackInlineScalarEditor, YouTrackOptionPicker } from './youtrack-field-editors'
import {
  isEditableKind,
  isOptionKind,
  useYouTrackProjectFields
} from './use-youtrack-project-fields'

function StaticRow({ name, value }: { name: string; value: string | null }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{name}</dt>
      <dd className="truncate px-1.5 py-1 text-[12px] text-foreground" title={value ?? undefined}>
        {value ?? '—'}
      </dd>
    </div>
  )
}

export function YouTrackFieldsAside({
  issue,
  onIssueChanged
}: {
  issue: YouTrackIssue
  onIssueChanged: (issue: YouTrackIssue) => void
}): React.JSX.Element {
  const { fields: schema, error } = useYouTrackProjectFields(issue.project.id || null)
  const [pendingField, setPendingField] = useState<string | null>(null)
  const valuesByName = new Map<string, YouTrackFieldValue>(
    issue.fields.map((field) => [field.name, field])
  )

  const save = async (field: YouTrackFieldSchema, values: string[]): Promise<void> => {
    const api = window.api?.youtrack
    if (!api || pendingField) {
      return
    }
    setPendingField(field.name)
    const result = await api.updateField({
      idReadable: issue.idReadable,
      projectId: issue.project.id,
      field: { name: field.name, values }
    })
    setPendingField(null)
    if (result.ok) {
      onIssueChanged(result.issue)
    } else {
      toast.error(result.error)
    }
  }

  // State has its own picker in the header; it's not repeated here.
  const editable = (schema ?? []).filter((field) => field.kind !== 'state')
  const schemaNames = new Set((schema ?? []).map((field) => field.name))
  const leftovers = schema
    ? issue.fields.filter(
        (field) => !schemaNames.has(field.name) && field.name !== issue.stateFieldName
      )
    : issue.fields.filter((field) => field.name !== issue.stateFieldName)

  return (
    <aside className="min-h-0 overflow-y-auto border-t border-border/50 bg-muted/20 px-3 py-3 scrollbar-sleek xl:border-l xl:border-t-0">
      <dl className="grid gap-1.5">
        <StaticRow
          name={translate('youtrack.detail.project', 'Project')}
          value={issue.project.name || issue.project.shortName}
        />
        <StaticRow
          name={translate('youtrack.detail.reporter', 'Reporter')}
          value={issue.reporter?.fullName ?? null}
        />
        {editable.map((field) => {
          const current = valuesByName.get(field.name)
          const values = current?.raw ?? []
          return (
            <div key={field.name} className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">
                {field.name}
                {field.required ? ' *' : ''}
              </dt>
              <dd className="min-w-0">
                {isOptionKind(field) ? (
                  <YouTrackOptionPicker
                    field={field}
                    values={values}
                    pending={pendingField === field.name}
                    onChange={(next) => void save(field, next)}
                  />
                ) : isEditableKind(field) ? (
                  <YouTrackInlineScalarEditor
                    field={field}
                    value={values[0] ?? ''}
                    pending={pendingField === field.name}
                    onSave={(next) => void save(field, next.trim() ? [next] : [])}
                  />
                ) : (
                  <span className="block truncate px-1.5 py-1 text-[12px] text-foreground">
                    {current?.value ?? '—'}
                  </span>
                )}
              </dd>
            </div>
          )
        })}
        {leftovers.map((field) => (
          <StaticRow key={field.name} name={field.name} value={field.value} />
        ))}
        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        {issue.tags.length > 0 ? (
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">
              {translate('youtrack.detail.tags', 'Tags')}
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1">
              {issue.tags.map((tag) => (
                <span
                  key={tag.name}
                  className="rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  {tag.name}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </aside>
  )
}
