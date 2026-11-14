import React from 'react'
import type { Editor } from '@tiptap/react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { runSlashCommand } from './rich-markdown-slash-commands'
import type {
  SlashCommand,
  SlashMenuState,
  SlashCommandGroup
} from './rich-markdown-slash-command-primitives'

import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { RichMarkdownCompletionPopover } from '../completion-popovers/RichMarkdownCompletionPopover'
import { useRichMarkdownCompletionScroll } from '../completion-popovers/useRichMarkdownCompletionScroll'

function slashCommandGroupLabel(group: SlashCommandGroup, t: Translate = translate): string {
  switch (group) {
    case 'Headings':
      return t('auto.components.editor.RichMarkdownSlashMenu.groupHeadings', 'Headings')
    case 'Toggle headings':
      return t(
        'auto.components.editor.RichMarkdownSlashMenu.groupToggleHeadings',
        'Toggle headings'
      )
    case 'Basic blocks':
      return t('auto.components.editor.RichMarkdownSlashMenu.groupBasicBlocks', 'Basic blocks')
    case 'Advanced':
      return t('auto.components.editor.RichMarkdownSlashMenu.groupAdvanced', 'Advanced')
    case 'Media':
      return t('auto.components.editor.RichMarkdownSlashMenu.groupMedia', 'Media')
    case 'Others':
      return t('auto.components.editor.RichMarkdownSlashMenu.groupOthers', 'Others')
  }
}

type RichMarkdownSlashMenuProps = {
  editor: Editor | null
  slashMenu: SlashMenuState
  filteredCommands: SlashCommand[]
  selectedIndex: number
  onImagePick: () => void
  onEmojiPick: () => void
  onClose: () => void
}

export function RichMarkdownSlashMenu({
  editor,
  slashMenu,
  filteredCommands,
  selectedIndex,
  onImagePick,
  onEmojiPick,
  onClose
}: RichMarkdownSlashMenuProps): React.JSX.Element {
  const t = useTranslate()
  const { viewportRef, activeItemRef } = useRichMarkdownCompletionScroll(
    selectedIndex,
    filteredCommands
  )
  let currentGroup: SlashCommand['group'] | null = null

  return (
    <RichMarkdownCompletionPopover
      editor={editor}
      position={slashMenu.to}
      onClose={onClose}
      className="rich-markdown-slash-menu"
      role="dialog"
      ariaLabel={t('auto.components.editor.RichMarkdownSlashMenu.2e0400b958', 'Slash commands')}
    >
      <div className="rich-markdown-slash-search" onMouseDown={(event) => event.preventDefault()}>
        <Search className="size-3.5" />
        <input
          aria-label={t('auto.components.editor.RichMarkdownSlashMenu.550189b06c', 'Search blocks')}
          readOnly
          type="text"
          value={slashMenu.query}
          placeholder={t(
            'auto.components.editor.RichMarkdownSlashMenu.dbdd2ad15f',
            'Search blocks...'
          )}
        />
      </div>
      <div ref={viewportRef} className="rich-markdown-slash-results scrollbar-sleek" role="listbox">
        {filteredCommands.length === 0 ? (
          <div className="rich-markdown-slash-empty">
            {t('auto.components.editor.RichMarkdownSlashMenu.82c6816ff8', 'No blocks found')}
          </div>
        ) : (
          filteredCommands.map((command, index) => {
            const showGroup = command.group !== currentGroup
            currentGroup = command.group
            return (
              <React.Fragment key={command.id}>
                {showGroup ? (
                  <div className="rich-markdown-slash-section">
                    {slashCommandGroupLabel(command.group, t)}
                  </div>
                ) : null}
                <button
                  ref={index === selectedIndex ? activeItemRef : undefined}
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
    </RichMarkdownCompletionPopover>
  )
}
