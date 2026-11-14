import { useState } from 'react'
import { ExternalLink, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { JiraEditField } from '../../../shared/jira/jira-types'

export function JiraIssueDescriptionAction({
  field,
  issueUrl,
  disabled,
  onEdit
}: {
  field: JiraEditField | undefined
  issueUrl: string
  disabled: boolean
  onEdit: () => void
}): React.JSX.Element | null {
  if (!field) {
    return null
  }
  if (field.writable) {
    const label = translate('jira.editFields.editDescription', 'Edit description')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            disabled={disabled}
            aria-label={label}
          >
            <Pencil className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="xs" onClick={() => window.api.shell.openUrl(issueUrl)}>
          <ExternalLink className="size-3" />
          {translate('jira.editFields.editInJira', 'Edit in Jira')}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {translate(
          'jira.editFields.descriptionLossy',
          'This description has content Orca cannot write back yet, such as images or mentions.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function JiraIssueDescriptionEditor({
  field,
  pending,
  onSave,
  onCancel
}: {
  field: JiraEditField
  pending: boolean
  onSave: (text: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(field.value.kind === 'text' ? field.value.text : '')
  return (
    <div className="grid gap-2">
      <Textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault()
            onCancel()
          }
        }}
        rows={10}
        disabled={pending}
        aria-label={translate('jira.editFields.descriptionLabel', 'Description')}
        className="min-h-40"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          {translate('jira.editFields.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={() => onSave(draft)} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {translate('jira.editFields.saveDescription', 'Save')}
        </Button>
      </div>
    </div>
  )
}
