import { useId, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { isValidWorkspaceUrl } from '../../../../shared/workspace-url'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

export function isWorkspaceUrlInputValid(input: string): boolean {
  const trimmed = input.trim()
  return trimmed === '' || isValidWorkspaceUrl(trimmed)
}

/** Writes the link only when it changed; '' clears it. */
export function buildWorkspaceUrlUpdate(
  input: string,
  saved: string
): Pick<WorktreeMeta, 'workspaceUrl'> | Record<string, never> {
  const trimmed = input.trim()
  return trimmed === saved ? {} : { workspaceUrl: trimmed }
}

export type WorkspaceUrlDraft = ReturnType<typeof useWorkspaceUrlDraft>

/** Edit state for the link field, seeded with the saved link. */
export function useWorkspaceUrlDraft(saved: string) {
  const [input, setInput] = useState(saved)
  return useMemo(
    () => ({
      input,
      setInput,
      valid: isWorkspaceUrlInputValid(input),
      withUpdate: (updates: Partial<WorktreeMeta>): Partial<WorktreeMeta> => ({
        ...updates,
        ...buildWorkspaceUrlUpdate(input, saved)
      })
    }),
    [input, saved]
  )
}

export function WorktreeWorkspaceUrlField({
  draft,
  onEnter
}: {
  draft: WorkspaceUrlDraft
  onEnter: () => void
}): React.JSX.Element {
  const inputId = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeWorkspaceUrlField.label', 'Link')}
      </label>
      <Input
        id={inputId}
        value={draft.input}
        aria-invalid={!draft.valid}
        onChange={(event) => draft.setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onEnter()
          }
        }}
        placeholder={translate(
          'auto.components.sidebar.WorktreeWorkspaceUrlField.placeholder',
          'https://app.test/admin'
        )}
        className="h-8"
      />
      <p className="text-[10px] text-muted-foreground">
        {draft.valid
          ? translate(
              'auto.components.sidebar.WorktreeWorkspaceUrlField.hint',
              'Opened from the card, the status bar, and the Open Workspace Link shortcut.'
            )
          : translate(
              'auto.components.sidebar.WorktreeWorkspaceUrlField.invalid',
              'Enter a full http:// or https:// link.'
            )}
      </p>
    </div>
  )
}
