import React from 'react'
import type { Editor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { runSlashCommand } from './rich-markdown-commands'
import type { SlashCommand, SlashMenuState } from './rich-markdown-commands'

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
      className="rich-markdown-slash-menu scrollbar-sleek"
      style={{ left: slashMenu.left, top: slashMenu.top }}
      role="listbox"
      aria-label="Slash commands"
    >
      <div className="rich-markdown-slash-query" aria-hidden="true">
        <span className="text-muted-foreground">/</span>
        <span>{slashMenu.query}</span>
      </div>
      {filteredCommands.map((command, index) => {
        const showGroup = command.group !== currentGroup
        currentGroup = command.group
        return (
          <React.Fragment key={command.id}>
            {showGroup ? <div className="rich-markdown-slash-section">{command.group}</div> : null}
            <button
              type="button"
              title={command.description}
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
                <span className="truncate text-[13px] font-medium leading-5">{command.label}</span>
              </span>
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}
