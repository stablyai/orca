import React from 'react'
import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Link as LinkIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { RichMarkdownTextColorControl } from './RichMarkdownTextColorControl'
import { RichMarkdownToolbarButton } from './RichMarkdownToolbarButton'

type RichMarkdownSelectionToolbarProps = {
  editor: Editor | null
  blocked: boolean
  scrollContainer: HTMLElement | null
  onToggleLink: () => void
}

type SelectionToolbarVisibilityArgs = {
  blocked: boolean
  editor: Editor
  element: HTMLElement
  view: EditorView
  state: EditorState
  from: number
  to: number
}

export function shouldShowRichMarkdownSelectionToolbar({
  blocked,
  editor,
  element,
  view,
  state,
  from,
  to
}: SelectionToolbarVisibilityArgs): boolean {
  const selection = state.selection
  const menuFocused = element.contains(document.activeElement)

  return (
    !blocked &&
    editor.isEditable &&
    selection instanceof TextSelection &&
    !selection.empty &&
    state.doc.textBetween(from, to).trim().length > 0 &&
    (view.hasFocus() || menuFocused)
  )
}

export function RichMarkdownSelectionToolbar({
  editor,
  blocked,
  scrollContainer,
  onToggleLink
}: RichMarkdownSelectionToolbarProps): React.JSX.Element | null {
  const [textColorPopoverOpen, setTextColorPopoverOpen] = React.useState(false)
  const activeMarks = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) =>
      activeEditor
        ? `${Number(activeEditor.isActive('bold'))}${Number(activeEditor.isActive('italic'))}${Number(activeEditor.isActive('strike'))}${Number(activeEditor.isActive('link'))}`
        : '0000'
  })
  const markState = activeMarks ?? '0000'

  if (!editor) {
    return null
  }

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="richMarkdownSelectionToolbar"
      className="rich-markdown-selection-toolbar"
      appendTo={() => document.body}
      shouldShow={(args) => shouldShowRichMarkdownSelectionToolbar({ ...args, editor, blocked })}
      options={{
        placement: 'top',
        offset: 8,
        flip: { padding: 8 },
        shift: { padding: 8 },
        inline: true,
        scrollTarget: scrollContainer ?? window,
        onHide: () => setTextColorPopoverOpen(false)
      }}
    >
      <RichMarkdownToolbarButton
        active={markState[0] === '1'}
        label={translate('auto.components.editor.RichMarkdownToolbar.4f9e789fe0', 'Bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={markState[1] === '1'}
        label={translate('auto.components.editor.RichMarkdownToolbar.6b4ccf9493', 'Italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </RichMarkdownToolbarButton>
      <RichMarkdownToolbarButton
        active={markState[2] === '1'}
        label={translate('auto.components.editor.RichMarkdownToolbar.0bea19a988', 'Strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        S
      </RichMarkdownToolbarButton>
      <div className="rich-markdown-toolbar-separator" />
      <RichMarkdownToolbarButton
        active={markState[3] === '1'}
        label={translate('auto.components.editor.RichMarkdownToolbar.6d52624712', 'Link')}
        onClick={onToggleLink}
      >
        <LinkIcon className="size-3.5" />
      </RichMarkdownToolbarButton>
      <RichMarkdownTextColorControl
        editor={editor}
        open={textColorPopoverOpen}
        onOpenChange={setTextColorPopoverOpen}
        closeOnSelectionCollapse
      />
    </BubbleMenu>
  )
}
