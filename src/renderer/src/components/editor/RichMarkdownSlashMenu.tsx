import React from 'react'
import type { Editor } from '@tiptap/react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { runSlashCommand } from './rich-markdown-slash-commands'
import type { SlashCommand, SlashMenuState } from './rich-markdown-slash-commands'
import { translate } from '@/i18n/i18n'

type RichMarkdownSlashMenuProps = {
  editor: Editor | null
  slashMenu: SlashMenuState
  filteredCommands: SlashCommand[]
  selectedIndex: number
  onImagePick: () => void
  onEmojiPick: () => void
}

export function RichMarkdownSlashMenu({
  editor,
  slashMenu,
  filteredCommands,
  selectedIndex,
  onImagePick,
  onEmojiPick
}: RichMarkdownSlashMenuProps): React.JSX.Element {
  let currentGroup: SlashCommand['group'] | null = null

  return (
    <div
      className="rich-markdown-slash-menu"
      style={{ left: slashMenu.left, top: slashMenu.top }}
      role="dialog"
      aria-label={translate(
        'auto.components.editor.RichMarkdownSlashMenu.2e0400b958',
        'Slash commands'
      )}
    >
      <div className="rich-markdown-slash-search" onMouseDown={(event) => event.preventDefault()}>
        <Search className="size-3.5" />
        <input
          aria-label={translate(
            'auto.components.editor.RichMarkdownSlashMenu.550189b06c',
            'Search blocks'
          )}
          readOnly
          type="text"
          value={slashMenu.query}
          placeholder={translate(
            'auto.components.editor.RichMarkdownSlashMenu.dbdd2ad15f',
            'Search blocks...'
          )}
        />
      </div>
      <div className="rich-markdown-slash-results scrollbar-sleek" role="listbox">
        {filteredCommands.length === 0 ? (
          <div className="rich-markdown-slash-empty">
            {translate(
              'auto.components.editor.RichMarkdownSlashMenu.82c6816ff8',
              'No blocks found'
            )}
          </div>
        ) : (
          filteredCommands.map((command, index) => {
            const showGroup = command.group !== currentGroup
            currentGroup = command.group
            return (
              <React.Fragment key={command.id}>
                {showGroup ? (
                  <div className="rich-markdown-slash-section">{command.group}</div>
                ) : null}
                <button
                  type="button"
                  title={command.description}
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={cn('rich-markdown-slash-item', index === selectedIndex && 'is-active')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    editor && runSlashCommand(editor, slashMenu, command, onImagePick, onEmojiPick)
                  }
                >
                  <span className="rich-markdown-slash-icon">
                    {command.icon.kind === 'component' ? (
                      <command.icon.component className="size-3.5" />
                    ) : (
                      <span className="text-sm leading-none">{command.icon.value}</span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="truncate text-[13px] font-medium leading-5">
                      {command.label}
                    </span>
                  </span>
                </button>
              </React.Fragment>
            )
          })
        )}
      </div>
    </div>
  )
}
