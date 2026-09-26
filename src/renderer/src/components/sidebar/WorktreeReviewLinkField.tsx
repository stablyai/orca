import { useId, type RefObject } from 'react'
import { Input } from '@/components/ui/input'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { translate } from '@/i18n/i18n'
import { isEditableReviewProvider, type WorktreeReviewProvider } from './worktree-meta-updates'

type WorktreeReviewLinkFieldProps = {
  inputRef: RefObject<HTMLInputElement | null>
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onValueChange: (value: string) => void
  /** null while the repo's provider is still being resolved. */
  provider: WorktreeReviewProvider | null
  value: string
}

function fieldCopy(provider: WorktreeReviewProvider | null): {
  label: string
  placeholder: string
  help: string
} {
  if (provider === null) {
    return {
      label: translate('auto.components.sidebar.WorktreeReviewLinkField.3c8a1f2e70', 'Review link'),
      placeholder: '',
      help: translate(
        'auto.components.sidebar.WorktreeReviewLinkField.9b4d6e0a13',
        'Checking which provider this repository uses...'
      )
    }
  }
  // Why: GitHub keeps its historical copy verbatim — no visible churn for the
  // common case; every other provider derives from the shared helper.
  if (provider === 'github') {
    return {
      label: translate('auto.components.sidebar.WorktreeMetaDialog.1b91db7e14', 'GH PR'),
      placeholder: translate(
        'auto.components.sidebar.WorktreeMetaDialog.077a4f7b5c',
        'PR # or GitHub URL'
      ),
      help: translate(
        'auto.components.sidebar.WorktreeMetaDialog.5ae06f40fd',
        'Paste a pull request URL, or enter a number. Leave blank to remove the link.'
      )
    }
  }
  const copy = localizedHostedReviewCopy(provider)
  const label = `${copy.providerName} ${copy.shortLabel}`
  if (!isEditableReviewProvider(provider)) {
    return {
      label,
      placeholder: '',
      help: translate(
        'auto.components.sidebar.WorktreeReviewLinkField.e5f2a7c391',
        "{{providerName}} {{reviewLabel}} links can't be changed here yet.",
        { providerName: copy.providerName, reviewLabel: copy.reviewLabel }
      )
    }
  }
  return {
    label,
    placeholder: translate(
      'auto.components.sidebar.WorktreeMetaDialog.gitlabPlaceholder',
      'MR ! or GitLab URL'
    ),
    help: translate(
      'auto.components.sidebar.WorktreeReviewLinkField.1d7b9c4f28',
      'Paste a {{reviewLabel}} URL, or enter a number. Leave blank to remove the link.',
      { reviewLabel: copy.reviewLabel }
    )
  }
}

export function WorktreeReviewLinkField({
  inputRef,
  onKeyDown,
  onValueChange,
  provider,
  value
}: WorktreeReviewLinkFieldProps): React.JSX.Element {
  const inputId = useId()
  const { label, placeholder, help } = fieldCopy(provider)
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        ref={inputRef}
        id={inputId}
        value={value}
        disabled={!isEditableReviewProvider(provider)}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="h-8 text-xs"
      />
      {/* Why: reserve the line so the dialog does not jump when detection lands. */}
      <p className="min-h-[14px] text-[10px] leading-[14px] text-muted-foreground">{help}</p>
    </div>
  )
}
