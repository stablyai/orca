import type { RefObject } from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { WorktreeReviewProvider } from './worktree-meta-updates'

type WorktreeReviewLinkFieldProps = {
  inputRef: RefObject<HTMLInputElement | null>
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  onValueChange: (value: string) => void
  provider: WorktreeReviewProvider
  value: string
}

export function WorktreeReviewLinkField({
  inputRef,
  onKeyDown,
  onValueChange,
  provider,
  value
}: WorktreeReviewLinkFieldProps): React.JSX.Element {
  const isGitLab = provider === 'gitlab'
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {isGitLab
          ? translate('auto.components.sidebar.WorktreeMetaDialog.gitlabMR', 'GitLab MR')
          : translate('auto.components.sidebar.WorktreeMetaDialog.1b91db7e14', 'GH PR')}
      </label>
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          isGitLab
            ? translate(
                'auto.components.sidebar.WorktreeMetaDialog.gitlabPlaceholder',
                'MR ! or GitLab URL'
              )
            : translate(
                'auto.components.sidebar.WorktreeMetaDialog.077a4f7b5c',
                'PR # or GitHub URL'
              )
        }
        className="h-8 text-xs"
      />
      <p className="text-[10px] text-muted-foreground">
        {isGitLab
          ? translate(
              'auto.components.sidebar.WorktreeMetaDialog.gitlabHelp',
              'Paste a merge request URL, or enter a number. Leave blank to remove the link.'
            )
          : translate(
              'auto.components.sidebar.WorktreeMetaDialog.5ae06f40fd',
              'Paste a pull request URL, or enter a number. Leave blank to remove the link.'
            )}
      </p>
    </div>
  )
}
