import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEditor, type Editor } from '@tiptap/react'

import Placeholder from '@tiptap/extension-placeholder'
import { Paperclip } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown/schema/rich-markdown-extensions'
import { RichMarkdownToolbar } from '@/components/editor/rich-markdown/commands/RichMarkdownToolbar'
import {
  getLinkBubblePosition,
  RichMarkdownLinkBubble,
  type LinkBubbleState
} from '@/components/editor/rich-markdown/links/RichMarkdownLinkBubble'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/rich-markdown/raw-source/raw-markdown-html'
import { createRichMarkdownEditorCodec } from '@/components/editor/rich-markdown/document/rich-markdown-source-transport'
import {
  createEditableMarkdownLinkBubble,
  getRichMarkdownSelectionLinkBubble
} from '@/components/editor/rich-markdown/links/rich-markdown-selected-link-actions'
import { useLinkBubble } from '@/components/editor/rich-markdown/links/useLinkBubble'
import { normalizeSoftBreaks } from '@/components/editor/rich-markdown/schema/rich-markdown-normalize'
import { GitHubMarkdownComposerPreviewPane } from '@/components/github/github-markdown-composer-preview-pane'
import { GitHubMarkdownComposerEditorPane } from '@/components/github/GitHubMarkdownComposerEditorPane'
import {
  GitHubMarkdownComposerTabbar,
  type ComposerTab
} from '@/components/github/github-markdown-composer-tabbar'
import { GitHubMarkdownImageInput } from './github-markdown-image-input'
import { useImageInput } from '@/components/github/use-image-input'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  getRichMarkdownSpellcheckAttribute,
  useRichMarkdownSpellcheckAttribute
} from '@/components/editor/rich-markdown/instance/rich-markdown-spellcheck'
import { createGitHubComposerLinkEventHandlers } from './github-markdown-composer-link-events'
import { useGitHubImagePaste } from './use-github-image-paste'
import type { GitHubImageUploadAddress } from './github-image-upload'

type GitHubMarkdownComposerProps = {
  imageUploadAddress?: GitHubImageUploadAddress | (() => GitHubImageUploadAddress)
  onImageUploadPendingChange?: (pending: boolean) => void
  value: string
  onChange: (value: string) => void
  placeholder: string
  minHeightClassName?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  onSubmitShortcut?: () => void
  layout?: 'stacked' | 'tabbed'
  previewGithubRepo?: GitHubOwnerRepo | null
}

export function GitHubMarkdownComposer({
  imageUploadAddress,
  onImageUploadPendingChange,
  value,
  onChange,
  placeholder,
  minHeightClassName = 'min-h-32',
  className,
  disabled = false,
  autoFocus = false,
  onSubmitShortcut,
  layout = 'stacked',
  previewGithubRepo = null
}: GitHubMarkdownComposerProps): React.JSX.Element {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const applyingExternalValueRef = useRef(false)
  const lastSyncedMarkdownRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSubmitShortcutRef = useRef(onSubmitShortcut)
  const disabledRef = useRef(disabled)
  const isEditingLinkRef = useRef(false)
  const richMarkdownSpellcheckEnabled = useAppStore(
    (s) => s.settings?.richMarkdownSpellcheckEnabled ?? true
  )
  const [activeTab, setActiveTab] = useState<ComposerTab>('write')
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)
  const isTabbed = layout === 'tabbed'
  const codec = useMemo(() => createRichMarkdownEditorCodec(), [])
  const images = useGitHubImagePaste(
    rootRef,
    editorRef,
    imageUploadAddress,
    onImageUploadPendingChange,
    !disabled && (!isTabbed || activeTab === 'write')
  )

  const {
    imageUrl,
    imageInputOpen,
    imageInputRef,
    openImagePicker,
    setImageUrl,
    setImageInputOpen,
    insertImageUrl
  } = useImageInput(editorRef, disabledRef, () => setActiveTab('write'))

  useLayoutEffect(() => {
    onChangeRef.current = onChange
    onSubmitShortcutRef.current = onSubmitShortcut
    disabledRef.current = disabled
    isEditingLinkRef.current = isEditingLink
  }, [disabled, isEditingLink, onChange, onSubmitShortcut])

  const extensions = useMemo(
    () => [
      ...createRichMarkdownExtensions({ codec, allowBase64Images: false, imageErrorLink: true }),
      images.extension,
      Placeholder.configure({
        includeChildren: true,
        placeholder
      })
    ],
    [codec, placeholder, images.extension]
  )

  const cancelHoverBubbleRef = useRef<() => void>(() => {})
  const closeLinkBubble = useCallback(() => {
    cancelHoverBubbleRef.current()
    setIsEditingLink(false)
    setLinkBubble(null)
  }, [])
  const openLinkEditor = useCallback(() => {
    const currentEditor = editorRef.current
    if (!currentEditor || disabledRef.current) {
      return
    }
    const selectionBubble = getRichMarkdownSelectionLinkBubble(currentEditor, rootRef.current)
    if (selectionBubble && selectionBubble.kind === 'markdown') {
      cancelHoverBubbleRef.current()
      setLinkBubble(selectionBubble)
      setIsEditingLink(true)
      return
    }
    const position = getLinkBubblePosition(currentEditor, rootRef.current)
    if (!position) {
      currentEditor.commands.focus()
      return
    }
    cancelHoverBubbleRef.current()
    setLinkBubble(createEditableMarkdownLinkBubble('', position))
    setIsEditingLink(true)
  }, [])

  const [linkEvents] = useState(() => createGitHubComposerLinkEventHandlers(closeLinkBubble))

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    editable: !disabled,
    content: encodeRawMarkdownHtmlForRichEditor(value, codec),
    contentType: 'markdown',
    editorProps: {
      handleDOMEvents: {
        paste: images.handlePaste,
        ...linkEvents.domEvents
      },
      handleClick: linkEvents.handleProseMirrorClick,
      transformPastedHTML: images.transformPastedHTML,
      attributes: {
        class: cn('rich-markdown-editor github-markdown-composer-editor', minHeightClassName),
        spellcheck: getRichMarkdownSpellcheckAttribute(richMarkdownSpellcheckEnabled)
      },
      handleKeyDown: (_view, event) => {
        if (isScreenSubmitShortcut(event)) {
          const submit = onSubmitShortcutRef.current
          if (submit) {
            event.preventDefault()
            event.stopPropagation()
            if (!images.pending.current) {
              submit()
            }
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
        if (event.key === 'Escape' && imageInputOpen) {
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
    onSelectionUpdate: () => {
      if (isEditingLinkRef.current) {
        setIsEditingLink(false)
        setLinkBubble(null)
      }
    }
  })
  const {
    handleLinkSave,
    handleLinkRemove,
    handleLinkEditCancel,
    handleLinkCopy,
    cancelHoverBubble,
    onBubblePointerEnter,
    onBubblePointerLeave
  } = useLinkBubble(editor, rootRef, linkBubble, isEditingLink, setLinkBubble, setIsEditingLink)
  useEffect(() => {
    cancelHoverBubbleRef.current = cancelHoverBubble
  }, [cancelHoverBubble])
  useRichMarkdownSpellcheckAttribute(editor, richMarkdownSpellcheckEnabled)

  useEffect(() => {
    if (!editor) {
      return
    }
    editorRef.current = editor
    editor.setEditable(!disabled, false)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor) {
      return
    }
    // Reset on the parent’s post-submit empty value so a successfully posted draft cannot linger.
    if (!value.trim()) {
      if (editor.getMarkdown().trim()) {
        applyingExternalValueRef.current = true
        try {
          editor.commands.clearContent(true)
          normalizeSoftBreaks(editor)
          lastSyncedMarkdownRef.current = ''
        } finally {
          applyingExternalValueRef.current = false
        }
      } else {
        lastSyncedMarkdownRef.current = ''
      }
      return
    }
    if (value === lastSyncedMarkdownRef.current || value === editor.getMarkdown()) {
      lastSyncedMarkdownRef.current = value
      return
    }
    applyingExternalValueRef.current = true
    try {
      editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(value, codec), {
        contentType: 'markdown',
        emitUpdate: false
      })
      normalizeSoftBreaks(editor)
      lastSyncedMarkdownRef.current = value
    } finally {
      applyingExternalValueRef.current = false
    }
  }, [codec, editor, value])

  const toolbar = (
    <RichMarkdownToolbar
      editor={editor}
      onToggleLink={openLinkEditor}
      onImagePick={openImagePicker}
    />
  )

  const imageInputRow = imageInputOpen ? (
    <GitHubMarkdownImageInput
      imageUrl={imageUrl}
      imageInputRef={imageInputRef}
      setImageUrl={setImageUrl}
      setImageInputOpen={setImageInputOpen}
      insertImageUrl={insertImageUrl}
      disabled={disabled}
    />
  ) : null
  const editorPane = <GitHubMarkdownComposerEditorPane disabled={disabled} editor={editor} />
  const previewPane = (
    <GitHubMarkdownComposerPreviewPane
      value={value}
      minHeightClassName={minHeightClassName}
      previewGithubRepo={previewGithubRepo}
    />
  )
  const attachmentFooter = isTabbed ? (
    <button
      type="button"
      className="github-markdown-composer-attachment"
      disabled={disabled}
      onClick={openImagePicker}
    >
      <Paperclip className="size-3.5 shrink-0" />
      <span>
        {t(
          'auto.components.github.GitHubMarkdownComposer.b7e4a1c902',
          'Paste, drop, or click to add files'
        )}
      </span>
    </button>
  ) : null
  return (
    <div
      ref={images.attachDrop}
      className={cn(
        'github-markdown-composer relative overflow-hidden rounded-md border border-input bg-background shadow-xs',
        isTabbed && 'github-markdown-composer-tabbed',
        disabled && 'opacity-60',
        className
      )}
    >
      {isTabbed ? (
        <GitHubMarkdownComposerTabbar activeTab={activeTab} onTabChange={setActiveTab}>
          {toolbar}
        </GitHubMarkdownComposerTabbar>
      ) : (
        toolbar
      )}
      {imageInputRow}
      {isTabbed ? (activeTab === 'write' ? editorPane : previewPane) : editorPane}
      {attachmentFooter}
      {linkBubble ? (
        <RichMarkdownLinkBubble
          anchorElement={rootRef.current}
          linkBubble={linkBubble}
          isEditing={isEditingLink}
          readOnly={disabled}
          onDismiss={() => {
            cancelHoverBubble()
            setLinkBubble(null)
            setIsEditingLink(false)
          }}
          onSave={handleLinkSave}
          onRemove={handleLinkRemove}
          onEditStart={() => {
            cancelHoverBubble()
            setIsEditingLink(true)
          }}
          onEditCancel={handleLinkEditCancel}
          onCopy={handleLinkCopy}
          onPointerEnter={onBubblePointerEnter}
          onPointerLeave={onBubblePointerLeave}
          portalToDocument
        />
      ) : null}
    </div>
  )
}
