import {
  readNativeChatDraftDocument,
  writeNativeChatDraftDocument
} from './native-chat-draft-cache'
import { hasUnsavedNativeChatComposerDraftChange } from './native-chat-composer-draft-store'
import { closeHistory } from '@tiptap/pm/history'
import { Slice } from '@tiptap/pm/model'
import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type HTMLAttributes,
  type RefObject
} from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import {
  fileReferenceContent,
  NativeChatFileReference,
  NativeChatSkill,
  promptTextContent,
  promptTextMap,
  promptTextOffset
} from './native-chat-prompt-document'
import type { NativeChatComposerInput } from './native-chat-composer-input'

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'onSelect'> & {
  scopeKey?: string
  inputRef: RefObject<NativeChatComposerInput | null>
  initialValue: string
  disabled: boolean
  placeholder: string
  onChange: (input: NativeChatComposerInput) => void
  onSelect: (input: NativeChatComposerInput) => void
}

export function NativeChatPromptEditor({
  scopeKey,
  inputRef,
  initialValue,
  disabled,
  placeholder,
  onChange,
  onSelect,
  className,
  ...events
}: Props): React.JSX.Element {
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          dropcursor: false,
          gapcursor: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          orderedList: false,
          strike: false,
          underline: false,
          trailingNode: false
        }),
        NativeChatSkill,
        NativeChatFileReference,
        Placeholder.configure({ placeholder: () => placeholderRef.current })
      ],
      content:
        (scopeKey && readNativeChatDraftDocument(scopeKey, initialValue)) ||
        promptTextContent(initialValue),
      editable: !disabled,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': placeholder,
          class: `${className ?? ''} whitespace-pre-wrap break-words [&_p]:m-0 [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_p.is-editor-empty:first-child]:before:text-chat-foreground-faint [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:pointer-events-none`,
          ...Object.fromEntries(Object.entries(events).filter(([key]) => key.startsWith('aria-')))
        },
        // Clipboard input is always literal text; only the picker and attachments create pills.
        handlePaste: (view, event) => {
          if (event.defaultPrevented) {
            return true
          }
          const text = event.clipboardData?.getData('text/plain')
          if (text == null) {
            return false
          }
          const content = editor?.schema.nodeFromJSON(promptTextContent(text))
          if (!content) {
            return false
          }
          view.dispatch(view.state.tr.replaceSelection(new Slice(content.content, 1, 1)))
          return true
        },
        clipboardTextSerializer: (slice) =>
          slice.content.textBetween(0, slice.content.size, '\n', (node) =>
            node.type.name === 'hardBreak' ? '\n' : String(node.attrs.token ?? '')
          )
      },
      onTransaction: ({ editor: current, transaction }) => {
        // Why: a value set from the store with no change of this window behind it (another
        // window's draft, a late load) is already saved; saving it back would make it one. A
        // value this window just set keeps its document, skill chips included.
        if (
          scopeKey &&
          transaction.docChanged &&
          (!transaction.getMeta('preventUpdate') ||
            hasUnsavedNativeChatComposerDraftChange(scopeKey))
        ) {
          writeNativeChatDraftDocument(
            scopeKey,
            promptTextMap(current.state.doc).text,
            current.getJSON()
          )
        }
      },
      onUpdate: () => {
        if (inputRef.current) {
          onChange(inputRef.current)
        }
      },
      onSelectionUpdate: () => {
        if (inputRef.current) {
          onSelect(inputRef.current)
        }
      }
    },
    []
  )

  useLayoutEffect(() => {
    editor?.setEditable(!disabled, false)
  }, [disabled, editor])

  const input = useMemo<NativeChatComposerInput | null>(
    () =>
      editor
        ? {
            insertText: (text) => {
              const content = editor.schema.nodeFromJSON(promptTextContent(text))
              editor.view.dispatch(
                editor.state.tr.replaceSelection(new Slice(content.content, 1, 1))
              )
            },
            get value() {
              return promptTextMap(editor.state.doc).text
            },
            set value(value: string) {
              const old = promptTextMap(editor.state.doc)
              if (old.text === value) {
                return
              }
              // A draft loaded or adopted whole keeps its skill chips: its stored document wins.
              const stored = scopeKey ? readNativeChatDraftDocument(scopeKey, value) : undefined
              if (stored) {
                editor.commands.setContent(stored, { emitUpdate: false })
                return
              }
              if (!value) {
                editor.commands.setContent(promptTextContent(''), { emitUpdate: false })
                return
              }
              let start = 0
              while (
                start < old.text.length &&
                start < value.length &&
                old.text[start] === value[start]
              ) {
                start++
              }
              let end = 0
              while (
                end < old.text.length - start &&
                end < value.length - start &&
                old.text[old.text.length - 1 - end] === value[value.length - 1 - end]
              ) {
                end++
              }
              // A text replacement intersecting an atom replaces its entire serialized token.
              while (start > 0 && old.positions[start - 1] === old.positions[start]) {
                start--
              }
              while (
                end > 0 &&
                old.positions[old.text.length - end] === old.positions[old.text.length - end - 1]
              ) {
                end--
              }
              const content = editor.schema.nodeFromJSON(
                promptTextContent(value.slice(start, value.length - end))
              )
              editor.commands.command(({ tr }) => {
                tr.replaceRange(
                  old.positions[start],
                  old.positions[old.text.length - end],
                  new Slice(content.content, 1, 1)
                )
                tr.setMeta('preventUpdate', true)
                return true
              })
            },
            get disabled() {
              return !editor.isEditable
            },
            set disabled(value: boolean) {
              editor.setEditable(!value)
            },
            get selectionStart() {
              return promptTextOffset(editor.state.doc, editor.state.selection.from)
            },
            get selectionEnd() {
              return promptTextOffset(editor.state.doc, editor.state.selection.to)
            },
            focus: () => {
              // Why: a blurred editor never writes its caret to the page, so focusing the element
              // alone would bring back the stale one and undo a caret moved by an insertion.
              editor.view.focus()
              if (!editor.isEditable) {
                editor.view.dom.focus()
              }
            },
            contains: (node) => editor.view.dom.contains(node),
            isCaretOnVisualEdge: (edge) => {
              const { selection, doc } = editor.state
              if (!selection.empty) {
                return false
              }
              const { text } = promptTextMap(doc)
              // An empty composer has one line: no layout read on the path every recall starts from.
              if (text === '') {
                return true
              }
              const caret = promptTextOffset(doc, selection.from)
              const beyond = edge === 'start' ? text.slice(0, caret) : text.slice(caret)
              // Why both: the text check covers other paragraphs, the view covers soft wraps.
              return (
                !beyond.includes('\n') &&
                editor.view.endOfTextblock(edge === 'start' ? 'up' : 'down')
              )
            },
            select: () => {
              editor.commands.selectAll()
            },
            setSelectionRange: (from, to) => {
              const { positions } = promptTextMap(editor.state.doc)
              editor.commands.setTextSelection({
                from: positions[Math.min(from ?? 0, positions.length - 1)],
                to: positions[Math.min(to ?? 0, positions.length - 1)]
              })
            },
            insertSkill: (from, to, token) => {
              const { positions } = promptTextMap(editor.state.doc)
              editor.view.dispatch(closeHistory(editor.state.tr))
              editor
                .chain()
                .insertContentAt({ from: positions[from], to: positions[to] }, [
                  { type: 'nativeChatSkill', attrs: { token } },
                  { type: 'text', text: ' ' }
                ])
                .run()
              editor.view.dispatch(closeHistory(editor.state.tr))
            },
            insertFileReferences: (paths) => {
              editor.commands.insertContentAt(
                editor.state.selection.from,
                paths.flatMap((path) => [fileReferenceContent(path), { type: 'text', text: ' ' }])
              )
            }
          }
        : null,
    [editor, scopeKey]
  )
  useImperativeHandle(inputRef, () => input!, [input])

  return <EditorContent editor={editor} {...events} />
}
