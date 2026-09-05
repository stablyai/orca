import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from '@/components/quick-open-search'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  slashCommandDispatchText,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import { useTerminalRichInputPathInsertion } from './use-terminal-rich-input-path-insertion'
import {
  getTerminalRichInputInlineImageFormatter,
  terminalRichInputCanAttachImages
} from './terminal-rich-input-image-support'
import {
  readTerminalRichInputDraft,
  writeTerminalRichInputDraft
} from './terminal-rich-input-draft'
import {
  terminalRichInputContentToText,
  terminalRichInputPathsToContent
} from './terminal-rich-input-model'
import { terminalRichInputClipboardProps } from './terminal-rich-input-clipboard'
import { TerminalRichInputFileMention } from './TerminalRichInputFileMention'
import { TerminalRichInputFileMenu } from './TerminalRichInputFileMenu'
import { TerminalRichInputAttachmentPending } from './TerminalRichInputAttachmentPending'
import { TerminalRichInputImageAttachment } from './TerminalRichInputImageAttachment'
import { RichInputPlaceholder, richInputPlaceholder } from './RichInputPlaceholder'
import { TerminalRichInputSlashMenu } from './TerminalRichInputSlashMenu'
import { TerminalRichInputSendButton } from './TerminalRichInputSendButton'
import {
  TerminalRichInputStatus,
  type TerminalRichInputSendNotice
} from './TerminalRichInputStatus'
import {
  findTerminalRichInputAutocomplete,
  sameTerminalRichInputAutocompleteQuery,
  type TerminalRichInputQuery
} from './terminal-rich-input-autocomplete'
import { useTerminalRichInputAnimation } from './use-terminal-rich-input-animation'
import { useTerminalRichInputAutocompleteAria } from './use-terminal-rich-input-autocomplete-aria'
import { useTerminalRichInputEditorAttachments } from './use-terminal-rich-input-editor-attachments'
import { useTerminalRichInputDrop } from './use-terminal-rich-input-drop'
import {
  handleTerminalRichInputKeyDown,
  insertTerminalRichInputHardBreak
} from './terminal-rich-input-keydown'
import { submitTerminalRichInputEditor } from './terminal-rich-input-editor-submit'
import type { TerminalRichInputProps } from './terminal-rich-input-types'

export function TerminalRichInput({
  open,
  pane,
  scopeKey,
  worktreeId,
  worktreePath,
  agent,
  connectionId,
  runtimeEnvironmentId,
  targetShell,
  onClose,
  onSubmit
}: TerminalRichInputProps): React.JSX.Element {
  const initialDraft = useMemo(() => readTerminalRichInputDraft(scopeKey), [scopeKey])
  const [draftState, setDraftState] = useState(() => ({ scopeKey, value: initialDraft }))
  const draft = draftState.scopeKey === scopeKey ? draftState.value : initialDraft
  const [mention, setMention] = useState<TerminalRichInputQuery | null>(null)
  const [slash, setSlash] = useState<TerminalRichInputQuery | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendNotice, setSendNotice] = useState<TerminalRichInputSendNotice>(null)
  const mentionRef = useRef(mention)
  const slashRef = useRef(slash)
  const suggestionsRef = useRef<string[]>([])
  const slashSuggestionsRef = useRef<SlashCommandSuggestion[]>([])
  const activeSuggestionRef = useRef(activeSuggestion)
  const chooseFileRef = useRef<(path: string) => void>(() => {})
  const chooseSlashRef = useRef<(command: SlashCommandSuggestion, submit: boolean) => void>(
    () => {}
  )
  const submitRef = useRef<() => void>(() => {})
  const closeRef = useRef(onClose)
  mentionRef.current = mention
  slashRef.current = slash
  activeSuggestionRef.current = activeSuggestion
  closeRef.current = onClose

  const setDraft = useCallback(
    (next: string, content: JSONContent) => {
      setDraftState({ scopeKey, value: next })
      writeTerminalRichInputDraft(scopeKey, next, content)
    },
    [scopeKey]
  )

  const editorRef = useRef<Editor | null>(null)
  const agentRef = useRef(agent)
  agentRef.current = agent
  const syncAutocomplete = useCallback((editor: Editor) => {
    const { mention: nextMention, slash: nextSlash } = findTerminalRichInputAutocomplete(
      editor,
      agentRef.current !== null
    )
    const mentionChanged = !sameTerminalRichInputAutocompleteQuery(nextMention, mentionRef.current)
    const slashChanged = !sameTerminalRichInputAutocompleteQuery(nextSlash, slashRef.current)
    if (mentionChanged) {
      setMention(nextMention)
    }
    if (slashChanged) {
      setSlash(nextSlash)
    }
    if (mentionChanged || slashChanged) {
      setActiveSuggestion(0)
    }
  }, [])
  const canAttachImages = terminalRichInputCanAttachImages(agent)
  const {
    attachments,
    attachmentBusy,
    attachmentPending,
    notice: attachmentNotice,
    appendImagePaths,
    handlePaste,
    mapPendingInsertionPositions,
    pasteImageFromClipboard,
    initialContent,
    resourceContext,
    syncEditorAttachments
  } = useTerminalRichInputEditorAttachments({
    scopeKey,
    initialDraft,
    parseFileReferences: Boolean(agent),
    connectionId,
    runtimeEnvironmentId,
    worktreeId,
    worktreePath,
    editorRef,
    enabled: canAttachImages
  })
  const handlePasteRef = useRef(handlePaste)
  const pasteImageFromClipboardRef = useRef(pasteImageFromClipboard)
  handlePasteRef.current = handlePaste
  pasteImageFromClipboardRef.current = pasteImageFromClipboard
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ heading: false, blockquote: false, codeBlock: false }),
        TerminalRichInputFileMention,
        TerminalRichInputImageAttachment
      ],
      content: initialContent,
      editorProps: {
        ...terminalRichInputClipboardProps(editorRef),
        attributes: {
          'aria-label': translate('components.terminal.richInput.label', 'Rich terminal input'),
          'aria-autocomplete': 'list',
          'aria-expanded': 'false',
          'aria-placeholder': richInputPlaceholder(agent),
          role: 'combobox',
          class:
            'terminal-rich-input-editor scrollbar-sleek min-h-12 max-h-40 overflow-y-auto px-2 py-1 text-sm outline-none'
        },
        handlePaste: (_view, event) =>
          handlePasteRef.current(event, editorRef.current?.state.selection.from),
        handleKeyDown: (_view, event) =>
          handleTerminalRichInputKeyDown(event, {
            mentionRef,
            slashRef,
            fileSuggestionsRef: suggestionsRef,
            slashSuggestionsRef,
            activeSuggestionRef,
            setActiveSuggestion,
            pasteImageFromClipboard: () =>
              pasteImageFromClipboardRef.current(false, editorRef.current?.state.selection.from),
            insertHardBreak: () =>
              editorRef.current ? insertTerminalRichInputHardBreak(editorRef.current) : false,
            chooseFile: (path) => chooseFileRef.current(path),
            chooseSlash: (command, submit) => chooseSlashRef.current(command, submit),
            closeAutocomplete: () => {
              setMention(null)
              setSlash(null)
            },
            closeComposer: () => closeRef.current(),
            submit: () => submitRef.current()
          })
      },
      onTransaction: ({ transaction }) =>
        transaction.docChanged && mapPendingInsertionPositions(transaction.mapping),
      onUpdate: ({ editor: updatedEditor }) => {
        const content = updatedEditor.getJSON()
        const next = terminalRichInputContentToText(content)
        syncEditorAttachments(content)
        setDraft(next, content)
        setSendNotice(null)
        syncAutocomplete(updatedEditor)
      },
      onSelectionUpdate: ({ editor: updatedEditor }) => syncAutocomplete(updatedEditor)
    },
    [scopeKey]
  )
  editorRef.current = editor
  useEffect(() => {
    setActiveSuggestion(0)
    if (editor) {
      syncAutocomplete(editor)
    }
  }, [agent, editor, syncAutocomplete])

  const fileList = useRuntimeFileListForWorktree({ enabled: mention !== null, worktreeId })
  const indexedFiles = useMemo(() => prepareQuickOpenFiles(fileList.files), [fileList.files])
  const suggestions = useMemo(
    () => rankQuickOpenFiles(mention?.query ?? '', indexedFiles, 8),
    [indexedFiles, mention?.query]
  )
  const suggestionPaths = useMemo(
    () => suggestions.map((suggestion) => suggestion.path),
    [suggestions]
  )
  suggestionsRef.current = suggestionPaths
  const slashSuggestions = useMemo(
    () => (agent ? filterSlashCommands(getAgentSlashCommands(agent), slash?.query ?? '') : []),
    [agent, slash?.query]
  )
  slashSuggestionsRef.current = slashSuggestions
  const {
    fileMenuId,
    slashMenuId,
    activeIndex: activeAutocompleteIndex
  } = useTerminalRichInputAutocompleteAria({
    editor,
    fileMenuOpen: mention !== null,
    fileSuggestionCount: suggestionPaths.length,
    slashMenuOpen: slash !== null && slashSuggestions.length > 0,
    slashSuggestionCount: slashSuggestions.length,
    activeSuggestion
  })
  activeSuggestionRef.current = activeAutocompleteIndex

  const chooseFile = useCallback(
    (filePath: string) => {
      const currentMention = mentionRef.current
      if (!editor || !currentMention) {
        return
      }
      editor
        .chain()
        .focus()
        .deleteRange({ from: currentMention.from, to: currentMention.to })
        .insertContent(terminalRichInputPathsToContent([filePath], true, resourceContext))
        .run()
      setMention(null)
      setActiveSuggestion(0)
    },
    [editor, resourceContext]
  )
  chooseFileRef.current = chooseFile

  const chooseSlash = useCallback(
    (command: SlashCommandSuggestion, submitAfterInsert: boolean) => {
      const currentSlash = slashRef.current
      if (!editor || !currentSlash) {
        return
      }
      editor
        .chain()
        .focus()
        .deleteRange({ from: currentSlash.from, to: currentSlash.to })
        .insertContent(
          submitAfterInsert ? slashCommandDispatchText(command) : applySlashSuggestion(command)
        )
        .run()
      setSlash(null)
      setActiveSuggestion(0)
      if (submitAfterInsert) {
        requestAnimationFrame(() => submitRef.current())
      }
    },
    [editor]
  )
  chooseSlashRef.current = chooseSlash

  const insertDroppedPaths = useTerminalRichInputPathInsertion({
    editor,
    agent,
    resourceContext,
    targetShell,
    sending,
    canAttachImages,
    appendImagePaths
  })
  const dropHandlers = useTerminalRichInputDrop({
    open,
    pane,
    insertPaths: insertDroppedPaths
  })
  const hasSubmissionContent = Boolean(draft.trim() || attachments.length > 0)
  const submissionBlocked = sending || attachmentBusy || dropHandlers.busy

  const submit = async (): Promise<void> => {
    if (submissionBlocked || !hasSubmissionContent || !editor) {
      return
    }
    setSending(true)
    setSendNotice(null)
    const result = await submitTerminalRichInputEditor({
      draft,
      attachments,
      editor,
      onSubmit,
      inlineImageText: getTerminalRichInputInlineImageFormatter(agent, targetShell)
    })
    setSending(false)
    // An unconfirmed send reached the PTY but may have preceded the agent editor's redraw.
    if (result.status === 'submitted') {
      setSendNotice(result.deliveryConfirmed ? null : 'unconfirmed')
    } else {
      setSendNotice(result.status)
    }
  }
  submitRef.current = () => void submit()

  const { layoutOpen } = useTerminalRichInputAnimation({ open, pane })

  useEffect(() => {
    if (open) {
      editor?.commands.focus('end')
    }
  }, [editor, open])

  return (
    <div
      className={cn('terminal-rich-input-dock min-w-0', !open && 'pointer-events-none')}
      data-layout-open={layoutOpen ? '' : undefined}
      data-visible={open ? '' : undefined}
      data-pane-prevent-terminal-focus=""
      aria-hidden={!open}
      inert={open ? undefined : true}
      onPasteCapture={(event) =>
        handlePaste(event.nativeEvent, editorRef.current?.state.selection.from)
      }
      onDragOver={dropHandlers.onDragOver}
      onDrop={dropHandlers.onDrop}
    >
      <div className="terminal-rich-input-dock-content min-h-0 overflow-hidden">
        <div className="relative bg-transparent px-2 pb-2 pt-1.5" data-terminal-rich-input-dock="">
          <div className="pointer-events-none absolute inset-x-0 top-0 flex -translate-y-1/2 items-center">
            <div className="h-px flex-1 bg-border" />
            <div className="px-1.5 text-[11px] leading-none text-muted-foreground">
              {translate('components.terminal.richInput.label', 'Rich terminal input')}
            </div>
            <div className="h-px w-3 bg-border" />
          </div>
          <div className="relative w-full">
            {mention ? (
              <TerminalRichInputFileMenu
                id={fileMenuId}
                loading={fileList.loading}
                error={fileList.loadError}
                paths={suggestionPaths}
                activeIndex={activeAutocompleteIndex}
                onChoose={chooseFile}
              />
            ) : null}
            {slash ? (
              <TerminalRichInputSlashMenu
                id={slashMenuId}
                suggestions={slashSuggestions}
                activeIndex={activeAutocompleteIndex}
                onChoose={(command) => chooseSlash(command, false)}
              />
            ) : null}
            {attachmentNotice ? (
              <div className="mb-1.5 px-1 text-xs text-destructive">{attachmentNotice}</div>
            ) : null}
            <div
              className="bg-transparent p-1.5"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  editor?.commands.focus('end')
                }
              }}
            >
              <TerminalRichInputAttachmentPending
                pending={attachmentPending || dropHandlers.imagePending}
              />
              <div className="relative">
                {!draft && attachments.length === 0 ? <RichInputPlaceholder agent={agent} /> : null}
                <EditorContent editor={editor} />
              </div>
              <div className="flex items-center gap-2 px-1 pt-0.5">
                <TerminalRichInputStatus notice={sendNotice} />
                <TerminalRichInputSendButton
                  sending={sending}
                  disabled={submissionBlocked || !hasSubmissionContent}
                  onSend={() => void submit()}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
