import React from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Columns3,
  Rows3
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'
import { runRichMarkdownTableAction } from './rich-markdown-table-actions'

export function RichMarkdownTableToolbar({
  editor
}: {
  editor: Editor | null
}): React.JSX.Element | null {
  const tableActive = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => currentEditor?.isActive('table') ?? false
  })

  if (!tableActive) {
    return null
  }

  return (
    <>
      <div className="rich-markdown-toolbar-separator" />
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.insertRowAbove',
          'Insert row above'
        )}
        onClick={() =>
          editor ? runRichMarkdownTableAction(editor, 'insert-row-above') : undefined
        }
      >
        <BetweenHorizontalStart className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.insertRowBelow',
          'Insert row below'
        )}
        onClick={() =>
          editor ? runRichMarkdownTableAction(editor, 'insert-row-below') : undefined
        }
      >
        <BetweenHorizontalEnd className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.deleteRow',
          'Delete current row'
        )}
        onClick={() => (editor ? runRichMarkdownTableAction(editor, 'delete-row') : undefined)}
      >
        <Rows3 className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.insertColumnLeft',
          'Insert column left'
        )}
        onClick={() =>
          editor ? runRichMarkdownTableAction(editor, 'insert-column-left') : undefined
        }
      >
        <BetweenVerticalStart className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.insertColumnRight',
          'Insert column right'
        )}
        onClick={() =>
          editor ? runRichMarkdownTableAction(editor, 'insert-column-right') : undefined
        }
      >
        <BetweenVerticalEnd className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={false}
        label={translate(
          'auto.components.editor.RichMarkdownTableToolbar.deleteColumn',
          'Delete current column'
        )}
        onClick={() => (editor ? runRichMarkdownTableAction(editor, 'delete-column') : undefined)}
      >
        <Columns3 className="size-3.5" />
      </RichMarkdownToolbarButton>
    </>
  )
}
