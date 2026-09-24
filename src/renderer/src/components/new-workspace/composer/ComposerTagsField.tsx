import React, { useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  normalizeWorktreeTag,
  normalizeWorktreeTags,
  worktreeTagKey
} from '../../../../../shared/worktree/metadata/worktree-tags'
import { useWorkspaceTagCommands } from '../../sidebar/workspace-tags/use-workspace-tag-commands'

const MAX_SUGGESTIONS = 8

/** Tags applied to the workspace once it is created; suggests tags already in use. */
export function ComposerTagsField({
  tags,
  onTagsChange,
  disabled
}: {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const inputId = useId()
  const { allTags } = useWorkspaceTagCommands()
  const [query, setQuery] = useState('')
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
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
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
        placeholder={translate(
          'auto.components.NewWorkspaceComposerCard.tagsPlaceholder',
          'Add a tag and press Enter'
        )}
      />
      {suggestions.length > 0 ? (
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
