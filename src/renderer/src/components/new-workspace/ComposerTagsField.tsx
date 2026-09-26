import React, { useId } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  MAX_WORKTREE_TAGS,
  normalizeWorktreeTag,
  normalizeWorktreeTags,
  worktreeTagKey
} from '../../../../shared/worktree/worktree-tags'
import { useWorkspaceTagCommands } from '../sidebar/use-workspace-tag-commands'
import { shouldSuppressEnterSubmit } from '@/lib/new-workspace-enter-guard'

const MAX_SUGGESTIONS = 8

/** Tags applied to the workspace once it is created; suggests tags already in use. */
export function ComposerTagsField({
  tags,
  onTagsChange,
  draft: query,
  onDraftChange: setQuery,
  disabled
}: {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  /** Typed tag not yet committed; lives in composer state so submit can include it. */
  draft: string
  onDraftChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const inputId = useId()
  const { allTags } = useWorkspaceTagCommands()
  const atLimit = tags.length >= MAX_WORKTREE_TAGS
  const selectedKeys = new Set(tags.map(worktreeTagKey))
  const queryKey = worktreeTagKey(query)
  const suggestions = allTags
    .filter((entry) => !selectedKeys.has(worktreeTagKey(entry.tag)))
    .filter((entry) => !queryKey || worktreeTagKey(entry.tag).includes(queryKey))
    .slice(0, MAX_SUGGESTIONS)

  const addTag = (raw: string): void => {
    const tag = normalizeWorktreeTag(raw)
    if (!tag) {
      return
    }
    // Why: reuse the existing spelling so "billing" joins "Billing" instead of shadowing it.
    const existing = allTags.find((entry) => worktreeTagKey(entry.tag) === worktreeTagKey(tag))
    onTagsChange(normalizeWorktreeTags([...tags, existing?.tag ?? tag]))
    setQuery('')
  }

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        {translate('auto.components.NewWorkspaceComposerCard.tags', 'Tags')}
      </label>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Button
              key={tag}
              type="button"
              variant="outline"
              size="xs"
              disabled={disabled}
              aria-label={translate(
                'auto.components.NewWorkspaceComposerCard.removeTag',
                'Remove tag {{value0}}',
                { value0: tag }
              )}
              onClick={() =>
                onTagsChange(tags.filter((entry) => worktreeTagKey(entry) !== worktreeTagKey(tag)))
              }
            >
              {tag}
              <X />
            </Button>
          ))}
        </div>
      ) : null}
      <Input
        id={inputId}
        value={query}
        disabled={disabled || atLimit}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (shouldSuppressEnterSubmit(event.nativeEvent, false)) {
            return
          }
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            // Why: Enter in the composer creates the workspace; here it only commits the tag.
            event.stopPropagation()
            addTag(query)
          } else if (event.key === 'Backspace' && query === '' && tags.length > 0) {
            onTagsChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => addTag(query)}
        placeholder={
          atLimit
            ? translate(
                'auto.components.NewWorkspaceComposerCard.tagsLimit',
                'A workspace can have up to 32 tags'
              )
            : translate(
                'auto.components.NewWorkspaceComposerCard.tagsPlaceholder',
                'Add a tag and press Enter'
              )
        }
      />
      {!atLimit && suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((entry) => (
            <Button
              key={entry.tag}
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(entry.tag)}
            >
              <Plus />
              {entry.tag}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
