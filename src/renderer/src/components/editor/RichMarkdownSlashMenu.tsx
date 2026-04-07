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
}

export function RichMarkdownSlashMenu({
  editor,
  slashMenu,
  filteredCommands,
  selectedIndex,
  onImagePick
}: RichMarkdownSlashMenuProps): React.JSX.Element {
  return (
    <div
      className="rich-markdown-slash-menu"
      style={{ left: slashMenu.left, top: slashMenu.top }}
      role="listbox"
      aria-label="Slash commands"
    >
      {filteredCommands.map((command, index) => {
        const Icon = command.icon
        return (
          <button
            key={command.id}
            type="button"
            className={cn('rich-markdown-slash-item', index === selectedIndex && 'is-active')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor && runSlashCommand(editor, slashMenu, command, onImagePick)}
          >
            <span className="rich-markdown-slash-icon">
              <Icon className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col items-start">
              <span className="truncate text-sm font-medium">{command.label}</span>
              <span className="truncate text-xs text-muted-foreground">{command.description}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
