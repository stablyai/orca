import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { getCommentBodySubmitState } from '@/lib/comment-body-submit-state'
import {
  buildResolutionFieldValue,
  classifyTransitionRequirements,
  transitionAllowedValueKey,
  transitionAllowedValueLabel
} from '../../../shared/jira/jira-transition-fields'
import type { JiraIssueUpdate, JiraTransition } from '../../../shared/jira/jira-types'

type Props = {
  transition: JiraTransition
  pending: boolean
  onBack: () => void
  onSubmit: (updates: JiraIssueUpdate) => Promise<void>
}

export function JiraTransitionFieldsForm({
  transition,
  pending,
  onBack,
  onSubmit
}: Props): React.JSX.Element | null {
  const [resolution, setResolution] = useState('')
  const [comment, setComment] = useState('')
  const requirement = classifyTransitionRequirements(transition)
  if (requirement.kind !== 'form') {
    return null
  }
  const resolutionValue = requirement.resolution
    ? buildResolutionFieldValue(requirement.resolution, resolution)
    : null
  const commentState = getCommentBodySubmitState(comment)
  const canSubmit =
    (!requirement.resolution || resolutionValue !== null) &&
    (!requirement.commentRequired || commentState.status === 'ready')

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (pending || !canSubmit || requirement.kind !== 'form') {
      return
    }
    const updates: JiraIssueUpdate = { transitionId: transition.id }
    if (requirement.resolution && resolutionValue) {
      updates.transitionFields = { [requirement.resolution.key]: resolutionValue }
    }
    if (requirement.commentRequired && commentState.status === 'ready') {
      updates.transitionComment = commentState.body
    }
    await onSubmit(updates)
  }

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <p className="text-sm font-medium">{transition.name}</p>
      {requirement.resolution ? (
        <div className="space-y-2">
          <Label htmlFor="jira-transition-resolution">{requirement.resolution.name}</Label>
          <Select value={resolution} onValueChange={setResolution} disabled={pending}>
            <SelectTrigger id="jira-transition-resolution" className="w-full" autoFocus>
              <SelectValue
                placeholder={translate('jira.transitions.chooseResolution', 'Choose a resolution')}
              />
            </SelectTrigger>
            <SelectContent>
              {(requirement.resolution.allowedValues ?? [])
                .filter((value) => transitionAllowedValueKey(value))
                .map((value) => (
                  <SelectItem
                    key={transitionAllowedValueKey(value)}
                    value={transitionAllowedValueKey(value)}
                  >
                    {transitionAllowedValueLabel(value)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {requirement.commentRequired ? (
        <div className="space-y-2">
          <Label htmlFor="jira-transition-comment">
            {translate('jira.transitions.comment', 'Comment')}
          </Label>
          <Textarea
            id="jira-transition-comment"
            autoFocus={!requirement.resolution}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            required
            disabled={pending}
            rows={3}
          />
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={pending}>
          {translate('jira.transitions.back', 'Back')}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !canSubmit}>
          {translate('jira.transitions.apply', 'Change status')}
        </Button>
      </div>
    </form>
  )
}
