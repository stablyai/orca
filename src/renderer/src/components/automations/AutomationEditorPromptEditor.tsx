import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { installMonacoEditorFindShortcut } from '@/components/editor/editor-shortcuts'
import { syncContentOnMount, syncContentUpdate } from '@/components/editor/monaco-content-sync'
import { isMonacoFindWidgetOpen } from '@/components/editor/monaco-find-widget'
import { computeEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import '@/lib/monaco-setup'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { buildAutomationPromptEditorOptions } from './automation-editor-prompt-options'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'

export const AUTOMATION_PROMPT_EDITOR_SLOT = 'automation-prompt-editor'

export function getAutomationPromptEditorRoot(
  dialog: EventTarget | null | undefined
): Element | null {
  return dialog instanceof Element
    ? dialog.querySelector(`[data-slot="${AUTOMATION_PROMPT_EDITOR_SLOT}"]`)
    : null
}

function installPromptEditorEscapeDismiss(
  target: HTMLElement,
  onDismissRef: { current?: () => void }
): () => void {
  const handleEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.repeat) {
      return
    }
    if (isMonacoFindWidgetOpen(target)) {
      return
    }
    // Monaco consumes Escape even with find closed; preserve the surrounding dialog’s dismiss path.
    if (!onDismissRef.current) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onDismissRef.current()
  }
  target.addEventListener('keydown', handleEscape, true)
  return () => target.removeEventListener('keydown', handleEscape, true)
}

type AutomationEditorPromptEditorProps = {
  value: string
  placeholder: string
  ariaLabel: string
  onChange: (value: string) => void
  onDismiss?: () => void
}

export function AutomationEditorPromptEditor({
  value,
  placeholder,
  ariaLabel,
  onChange,
  onDismiss
}: AutomationEditorPromptEditorProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const editorFontZoomLevel = useAppStore((state) => state.editorFontZoomLevel)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const contentRef = useRef(value)
  const lastSyncedContentRef = useRef(value)
  const isApplyingProgrammaticContentRef = useRef(false)
  const onDismissRef = useRef(onDismiss)

  useLayoutEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const fontFamily = resolveEditorFontFamily(settings)
  const monacoTheme = useMonacoTheme()
  const options = useMemo(
    () =>
      buildAutomationPromptEditorOptions({
        ariaLabel,
        fontFamily,
        fontSize,
        placeholder
      }),
    [ariaLabel, fontFamily, fontSize, placeholder]
  )

  const handleChange = useCallback(
    (nextValue: string | undefined) => {
      if (isApplyingProgrammaticContentRef.current) {
        return
      }
      const next = nextValue ?? ''
      lastSyncedContentRef.current = next
      onChange(next)
    },
    [onChange]
  )

  const handleMount = useCallback<OnMount>((editorInstance) => {
    editorRef.current = editorInstance
    const editorDomNode = editorInstance.getContainerDomNode()
    const cleanupFindShortcut = installMonacoEditorFindShortcut(editorInstance)
    const cleanupEscapeDismiss = installPromptEditorEscapeDismiss(editorDomNode, onDismissRef)
    isApplyingProgrammaticContentRef.current = true
    try {
      if (syncContentOnMount(editorInstance, contentRef.current)) {
        lastSyncedContentRef.current = contentRef.current
      }
    } finally {
      isApplyingProgrammaticContentRef.current = false
    }
    editorInstance.onDidDispose(() => {
      cleanupFindShortcut()
      cleanupEscapeDismiss()
      if (editorRef.current === editorInstance) {
        editorRef.current = null
      }
    })
  }, [])

  // Apply template changes as undoable model edits; setValue would discard Cmd+Z history.
  useLayoutEffect(() => {
    contentRef.current = value
    const mountedEditor = editorRef.current
    if (!mountedEditor || lastSyncedContentRef.current === value) {
      return
    }
    isApplyingProgrammaticContentRef.current = true
    try {
      syncContentUpdate(mountedEditor, value)
      lastSyncedContentRef.current = value
    } finally {
      isApplyingProgrammaticContentRef.current = false
    }
  }, [value])

  return (
    <div
      data-slot={AUTOMATION_PROMPT_EDITOR_SLOT}
      className={cn(
        'relative min-h-0 w-full flex-1 overflow-hidden rounded-lg border border-border/70 bg-editor-surface',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        // Tint Monaco’s placeholder token as ghost text rather than typed content.
        '[--vscode-editor-placeholder-foreground:color-mix(in_srgb,var(--muted-foreground)_50%,transparent)]'
      )}
    >
      <div className="absolute inset-0">
        <Editor
          height="100%"
          defaultLanguage="plaintext"
          // Own post-mount syncing; a controlled value would wipe Monaco’s undo stack.
          defaultValue={value}
          theme={monacoTheme}
          onChange={handleChange}
          onMount={handleMount}
          options={options}
          loading={<div className="h-full w-full bg-editor-surface" aria-hidden="true" />}
        />
      </div>
    </div>
  )
}
