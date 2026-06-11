import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { RichMarkdownToolbar } from '@/components/editor/RichMarkdownToolbar'
import {
  getLinkBubblePosition,
  RichMarkdownLinkBubble,
  type LinkBubbleState
} from '@/components/editor/RichMarkdownLinkBubble'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/raw-markdown-html'
import { normalizeSoftBreaks } from '@/components/editor/rich-markdown-normalize'
import { translate } from '@/i18n/i18n'

type GitHubMarkdownComposerProps = {
  value: string
  onChange: (value: string) => void
  placeholder: string
  minHeightClassName?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  onSubmitShortcut?: () => void
}

function isHttpImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function GitHubMarkdownComposer({
  value,
  onChange,
  placeholder,
  minHeightClassName = 'min-h-32',
  className,
  disabled = false,
  autoFocus = false,
  onSubmitShortcut
}: GitHubMarkdownComposerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const applyingExternalValueRef = useRef(false)
  const lastSyncedMarkdownRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSubmitShortcutRef = useRef(onSubmitShortcut)
  const disabledRef = useRef(disabled)
  const isEditingLinkRef = useRef(false)
  const imageInputOpenRef = useRef(false)
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const [imageInputOpen, setImageInputOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const imageInputRef = useRef<HTMLInputElement | null>(null)

  onChangeRef.current = onChange
  onSubmitShortcutRef.current = onSubmitShortcut
  disabledRef.current = disabled
  isEditingLinkRef.current = isEditingLink
  imageInputOpenRef.current = imageInputOpen

  const extensions = useMemo(
    () => [
      ...createRichMarkdownExtensions(),
      Placeholder.configure({
        includeChildren: true,
        placeholder
      })
    ],
    [placeholder]
  )

  const openLinkEditor = useCallback(() => {
    const editor = editorRef.current
    if (!editor || disabledRef.current) {
      return
    }
    const position = getLinkBubblePosition(editor, rootRef.current)
    if (!position) {
      editor.commands.focus()
      return
    }
    const href = editor.isActive('link') ? String(editor.getAttributes('link').href ?? '') : ''
    setLinkBubble({ href, ...position })
    setIsEditingLink(true)
  }, [])

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    editable: !disabled,
    content: encodeRawMarkdownHtmlForRichEditor(value),
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: cn('rich-markdown-editor github-markdown-composer-editor', minHeightClassName),
        spellcheck: 'true'
      },
      handleKeyDown: (_view, event) => {
        if (isScreenSubmitShortcut(event)) {
          const submit = onSubmitShortcutRef.current
          if (submit) {
            event.preventDefault()
            event.stopPropagation()
            submit()
            return true
          }
        }
        const isMac = navigator.userAgent.includes('Mac')
        const mod = isMac ? event.metaKey : event.ctrlKey
        if (mod && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          event.stopPropagation()
          openLinkEditor()
          return true
        }
        if (event.key === 'Escape' && imageInputOpenRef.current) {
          event.preventDefault()
          event.stopPropagation()
          setImageInputOpen(false)
          return true
        }
        return false
      }
    },
    onCreate: ({ editor: nextEditor }) => {
      editorRef.current = nextEditor
      normalizeSoftBreaks(nextEditor)
      lastSyncedMarkdownRef.current = value
      if (autoFocus) {
        requestAnimationFrame(() => nextEditor.commands.focus('end'))
      }
    },
    onDestroy: () => {
      editorRef.current = null
    },
    onUpdate: ({ editor: nextEditor }) => {
      if (applyingExternalValueRef.current) {
        return
      }
      const markdown = nextEditor.getMarkdown()
      lastSyncedMarkdownRef.current = markdown
      onChangeRef.current(markdown)
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      if (isEditingLinkRef.current) {
        return
      }
      if (nextEditor.isActive('link')) {
        const position = getLinkBubblePosition(nextEditor, rootRef.current)
        if (position) {
          setLinkBubble({
            href: String(nextEditor.getAttributes('link').href ?? ''),
            ...position
          })
          return
        }
      }
      setLinkBubble(null)
    }
  })

  useEffect(() => {
    if (!editor) {
      return
    }
    editorRef.current = editor
    editor.setEditable(!disabled)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) {
      return
    }
    if (value === lastSyncedMarkdownRef.current || value === editor.getMarkdown()) {
      lastSyncedMarkdownRef.current = value
      return
    }
    applyingExternalValueRef.current = true
    try {
      editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(value), {
        contentType: 'markdown',
        emitUpdate: false
      })
      normalizeSoftBreaks(editor)
      lastSyncedMarkdownRef.current = value
    } finally {
      applyingExternalValueRef.current = false
    }
  }, [editor, value])

  useEffect(() => {
    if (imageInputOpen) {
      requestAnimationFrame(() => imageInputRef.current?.focus())
    }
  }, [imageInputOpen])

  const handleLinkSave = useCallback((href: string) => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    if (href) {
      if (editor.isActive('link')) {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      } else if (editor.state.selection.empty) {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: href,
            marks: [{ type: 'link', attrs: { href } }]
          })
          .run()
      } else {
        editor.chain().focus().setLink({ href }).run()
      }
    } else if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    }
    setIsEditingLink(false)
  }, [])

  const handleLinkRemove = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkBubble(null)
    setIsEditingLink(false)
  }, [])

  const handleLinkOpen = useCallback(() => {
    if (linkBubble?.href) {
      window.api.shell.openUrl(linkBubble.href)
    }
  }, [linkBubble?.href])

  const insertImageUrl = useCallback(() => {
    const editor = editorRef.current
    const trimmed = imageUrl.trim()
    if (!editor || !trimmed) {
      return
    }
    if (!isHttpImageUrl(trimmed)) {
      toast.error(
        translate(
          'auto.components.github.GitHubMarkdownComposer.ec6310b731',
          'Use an http:// or https:// image URL.'
        )
      )
      return
    }
    editor
      .chain()
      .focus()
      .insertContent({ type: 'image', attrs: { src: trimmed } })
      .run()
    setImageUrl('')
    setImageInputOpen(false)
  }, [imageUrl])

  return (
    <div
      ref={rootRef}
      className={cn(
        'github-markdown-composer relative overflow-hidden rounded-md border border-input bg-background shadow-xs',
        disabled && 'opacity-60',
        className
      )}
    >
      <RichMarkdownToolbar
        editor={editor}
        onToggleLink={openLinkEditor}
        onImagePick={() => {
          if (!disabledRef.current) {
            setImageInputOpen(true)
          }
        }}
      />
      {imageInputOpen ? (
        <form
          className="github-markdown-composer-image-row"
          onSubmit={(event) => {
            event.preventDefault()
            insertImageUrl()
          }}
        >
          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={imageInputRef}
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            onKeyDown={(event) => {
              if (isScreenSubmitShortcut(event)) {
                event.preventDefault()
                event.stopPropagation()
                insertImageUrl()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setImageInputOpen(false)
              }
            }}
            placeholder={translate(
              'auto.components.github.GitHubMarkdownComposer.f24783f470',
              'https://...'
            )}
            disabled={disabled}
            className="h-8 min-w-0 text-xs"
          />
          <Button type="submit" size="xs" disabled={disabled || !imageUrl.trim()}>
            {translate('auto.components.github.GitHubMarkdownComposer.e3bd59143c', 'Insert')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setImageInputOpen(false)}>
            {translate('auto.components.github.GitHubMarkdownComposer.015b4e607d', 'Cancel')}
          </Button>
        </form>
      ) : null}
      <div className="max-h-[360px] overflow-y-auto scrollbar-sleek">
        <EditorContent editor={editor} />
      </div>
      {linkBubble ? (
        <RichMarkdownLinkBubble
          linkBubble={linkBubble}
          isEditing={isEditingLink}
          onSave={handleLinkSave}
          onRemove={handleLinkRemove}
          onEditStart={() => setIsEditingLink(true)}
          onEditCancel={() => {
            setIsEditingLink(false)
            if (!linkBubble.href) {
              setLinkBubble(null)
            }
            editorRef.current?.commands.focus()
          }}
          onOpen={handleLinkOpen}
        />
      ) : null}
    </div>
  )
}
