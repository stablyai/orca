import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { JiraUserPicker } from '@/components/jira-user-picker'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraEditField, JiraIssueUpdate } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { JiraEditFieldOptionPicker } from './jira-edit-field-option-picker'
import type { JiraEditFieldEditor } from '../../../shared/jira/jira-edit-field-editor'
import {
  buildJiraEditFieldUpdate,
  getJiraEditFieldDisplay,
  getJiraEditFieldDraft,
  getJiraEditFieldEditor
} from './jira-issue-edit-field-drafts'

const INPUT_TYPES: Partial<Record<JiraEditFieldEditor, string>> = {
  number: 'number',
  date: 'date',
  datetime: 'datetime-local'
}

type Props = {
  field: JiraEditField
  pending: boolean
  disabled: boolean
  owner: RuntimeClientTarget
  siteId?: string
  onSave: (field: JiraEditField, update: JiraIssueUpdate) => Promise<boolean>
}

/** One edit-screen field; callers key it by value so a reload resets the draft. */
export function JiraIssueEditFieldControl({
  field,
  pending,
  disabled,
  owner,
  siteId,
  onSave
}: Props): React.JSX.Element {
  const editor = getJiraEditFieldEditor(field)
  const initialDraft = getJiraEditFieldDraft(field)
  const [draft, setDraft] = useState(initialDraft)
  const textDraft = typeof draft === 'string' ? draft : ''
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft)
  const inputId = `jira-edit-field-${field.key}`

  const save = (nextDraft: string | string[]): void => {
    const update = buildJiraEditFieldUpdate(field, nextDraft)
    if (!update) {
      toast.error(
        field.required
          ? translate('jira.editFields.required', '{{field}} is required.', { field: field.name })
          : translate('jira.editFields.invalid', 'Enter a valid value for {{field}}.', {
              field: field.name
            })
      )
      return
    }
    void onSave(field, update)
  }

  const saveButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => save(draft)}
      disabled={disabled || !dirty}
      aria-label={translate('jira.editFields.save', 'Save {{field}}', { field: field.name })}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
    </Button>
  )

  let control: React.JSX.Element
  if (editor === 'readonly') {
    control = (
      <p className="min-h-8 py-1.5 text-xs text-foreground">
        {getJiraEditFieldDisplay(field) || '—'}
      </p>
    )
  } else if (editor === 'select' || editor === 'multi-select') {
    control = (
      <JiraEditFieldOptionPicker
        field={field}
        selected={Array.isArray(initialDraft) ? initialDraft : initialDraft ? [initialDraft] : []}
        multiple={editor === 'multi-select'}
        pending={pending}
        disabled={disabled}
        onCommit={(keys) => save(editor === 'multi-select' ? keys : (keys[0] ?? ''))}
      />
    )
  } else if (editor === 'user') {
    const selectedUser = field.value.kind === 'users' ? (field.value.users[0] ?? null) : null
    control = (
      <JiraUserPicker
        providerSettings={owner}
        siteId={siteId}
        value={textDraft}
        selectedUser={selectedUser}
        disabled={disabled}
        label={field.name}
        fixedOptions={
          field.required
            ? undefined
            : [
                {
                  key: 'none',
                  label: translate('jira.editFields.none', 'None'),
                  onSelect: () => save('')
                }
              ]
        }
        onSelect={(user) => save(user.accountId)}
      />
    )
  } else if (editor === 'textarea') {
    control = (
      <div className="flex gap-2">
        <Textarea
          id={inputId}
          value={textDraft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          disabled={disabled}
          className="min-h-16"
        />
        <div className="self-end">{saveButton}</div>
      </div>
    )
  } else {
    control = (
      <div className="flex gap-2">
        <Input
          id={inputId}
          type={INPUT_TYPES[editor] ?? 'text'}
          value={textDraft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && dirty) {
              event.preventDefault()
              save(draft)
            }
          }}
          placeholder={
            editor === 'strings'
              ? translate('jira.editFields.commaSeparated', 'Comma-separated values')
              : undefined
          }
          disabled={disabled}
          className="h-8"
        />
        {saveButton}
      </div>
    )
  }

  return (
    <div className={cn('grid gap-1', editor === 'textarea' && 'sm:col-span-2')}>
      <label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground">
        {field.required ? `${field.name} *` : field.name}
      </label>
      {control}
    </div>
  )
}
