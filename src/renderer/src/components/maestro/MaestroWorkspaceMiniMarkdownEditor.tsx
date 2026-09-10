import { useEffect, useMemo, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Bold, Code, Heading2, Italic, List, ListTodo, Quote } from 'lucide-react'
import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/raw-markdown-html'
import { createRichMarkdownEditorCodec } from '@/components/editor/rich-markdown-source-transport'
import { getRichMarkdownSpellcheckAttribute } from '@/components/editor/rich-markdown-spellcheck'
import { translate } from '@/i18n/i18n'

export function MaestroWorkspaceMiniMarkdownEditor({
  content,
  onSave
}: {
  content: string
  onSave: (content: string) => void
}): React.JSX.Element {
  const latestMarkdown = useRef(content)
  const dirty = useRef(false)
  const codec = useMemo(() => createRichMarkdownEditorCodec(), [])
  const extensions = useMemo(
    () => createRichMarkdownExtensions({ codec, includePlaceholder: true }),
    [codec]
  )
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'rich-markdown-editor',
        spellcheck: getRichMarkdownSpellcheckAttribute(true),
        'aria-label': translate(
          'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.editAnnotation',
          'Edit annotation'
        )
      }
    },
    onFocus: () => window.api.ui.setMarkdownEditorFocused(true),
    onBlur: ({ editor: nextEditor }) => {
      window.api.ui.setMarkdownEditorFocused(false)
      const next = nextEditor.getMarkdown()
      latestMarkdown.current = next
      if (dirty.current) {
        dirty.current = false
        onSave(next)
      }
    },
    onUpdate: ({ editor: nextEditor }) => {
      dirty.current = true
      latestMarkdown.current = nextEditor.getMarkdown()
    }
  })

  useEffect(() => {
    if (!editor || content === latestMarkdown.current) {
      return
    }
    editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(content, codec), {
      contentType: 'markdown',
      emitUpdate: false
    })
    dirty.current = false
    latestMarkdown.current = content
  }, [codec, content, editor])

  useEffect(() => () => window.api.ui.setMarkdownEditorFocused(false), [])

  return (
    <div className="maestro-mini-markdown-editor flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="linear-issue-markdown-toolbar"
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.annotationFormatting',
          'Annotation formatting'
        )}
      >
        {[
          [
            translate(
              'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.heading',
              'Heading'
            ),
            Heading2,
            () => editor?.chain().focus().toggleHeading({ level: 2 }).run()
          ],
          [
            translate('auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.bold', 'Bold'),
            Bold,
            () => editor?.chain().focus().toggleBold().run()
          ],
          [
            translate(
              'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.italic',
              'Italic'
            ),
            Italic,
            () => editor?.chain().focus().toggleItalic().run()
          ],
          [
            translate(
              'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.inlineCode',
              'Inline code'
            ),
            Code,
            () => editor?.chain().focus().toggleCode().run()
          ],
          [
            translate(
              'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.bulletList',
              'Bullet list'
            ),
            List,
            () => editor?.chain().focus().toggleBulletList().run()
          ],
          [
            translate(
              'auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.taskList',
              'Task list'
            ),
            ListTodo,
            () => editor?.chain().focus().toggleTaskList().run()
          ],
          [
            translate('auto.components.maestro.MaestroWorkspaceMiniMarkdownEditor.quote', 'Quote'),
            Quote,
            () => editor?.chain().focus().toggleBlockquote().run()
          ]
        ].map(([label, Icon, command]) => (
          <button
            key={label as string}
            type="button"
            className="linear-issue-markdown-toolbar-button"
            aria-label={label as string}
            onMouseDown={(event) => event.preventDefault()}
            onClick={command as () => void}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
