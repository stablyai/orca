import { useRef, useState } from 'react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Plus, Tag } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import { normalizeWorktreeTag, worktreeTagKey } from '../../../../shared/worktree/worktree-tags'
import { getTagSelectionState } from './workspace-tag-actions'
import { useWorkspaceTagCommands } from './use-workspace-tag-commands'

export function WorktreeTagsMenuItems(props: {
  contextWorktrees: readonly Worktree[]
  disabled: boolean
}) {
  const { allTags, resolveLive, toggleTag } = useWorkspaceTagCommands()
  const liveWorktrees = resolveLive(props.contextWorktrees)
  const onToggleTag = (tag: string) => void toggleTag(props.contextWorktrees, tag)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const openedByKeyboardRef = useRef(false)
  const typed = normalizeWorktreeTag(query)
  const typedKey = worktreeTagKey(typed)
  const visibleTags = typedKey
    ? allTags.filter((entry) => worktreeTagKey(entry.tag).includes(typedKey))
    : allTags
  const canCreate =
    typed.length > 0 && !allTags.some((entry) => worktreeTagKey(entry.tag) === typedKey)

  const submitTyped = () => {
    if (!typed) {
      return
    }
    const existing = allTags.find((entry) => worktreeTagKey(entry.tag) === typedKey)
    onToggleTag(existing?.tag ?? typed)
    setQuery('')
  }

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (!open) {
          setQuery('')
          return
        }
        // Why: the search box is not a menu item, so keyboard users could never reach it otherwise.
        // Pointer opens keep Radix's own focus handling, which a moved focus would disturb.
        if (openedByKeyboardRef.current) {
          openedByKeyboardRef.current = false
          requestAnimationFrame(() => inputRef.current?.focus())
        }
      }}
    >
      <DropdownMenuSubTrigger
        disabled={props.disabled}
        onKeyDown={(event) => {
          openedByKeyboardRef.current = ['ArrowRight', 'Enter', ' '].includes(event.key)
        }}
      >
        <Tag className="size-3.5" />
        {translate('auto.components.sidebar.WorktreeContextMenu.tags', 'Tags')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <div className="p-1">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitTyped()
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                event.currentTarget
                  .closest('[role="menu"]')
                  ?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')
                  ?.focus()
              }
              // Why: Radix typeahead and arrow handling would otherwise steal keystrokes.
              if (event.key !== 'Escape' && event.key !== 'Tab') {
                event.stopPropagation()
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder={translate(
              'auto.components.sidebar.WorktreeContextMenu.tagsSearch',
              'Find or create a tag…'
            )}
            aria-label={translate(
              'auto.components.sidebar.WorktreeContextMenu.tagsSearch',
              'Find or create a tag…'
            )}
            className="h-7"
          />
        </div>
        <div className="max-h-64 overflow-y-auto scrollbar-sleek">
          {visibleTags.map((entry) => {
            const state = getTagSelectionState(liveWorktrees, entry.tag)
            return (
              <DropdownMenuCheckboxItem
                key={worktreeTagKey(entry.tag)}
                checked={state === 'all'}
                onSelect={(event) => {
                  // Why: keep the menu open so several tags can be toggled in one go.
                  event.preventDefault()
                  onToggleTag(entry.tag)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{entry.tag}</span>
                {state === 'some' ? (
                  <span className="text-muted-foreground">
                    {translate('auto.components.sidebar.WorktreeContextMenu.tagsPartial', 'some')}
                  </span>
                ) : null}
              </DropdownMenuCheckboxItem>
            )
          })}
        </div>
        {canCreate ? (
          <>
            {visibleTags.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                submitTyped()
              }}
            >
              <Plus className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.tagsCreate',
                  'Create “{{value0}}”',
                  {
                    value0: typed
                  }
                )}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
        {visibleTags.length === 0 && !canCreate ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.WorktreeContextMenu.tagsEmpty',
              'Type a name to create the first tag'
            )}
          </div>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
