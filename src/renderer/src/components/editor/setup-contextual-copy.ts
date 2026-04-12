import type { editor } from 'monaco-editor'
import { formatCopiedSelectionWithContext, getContextualCopyLineRange } from './selection-copy'

export function setupContextualCopy({
  editorInstance,
  monaco,
  filePath,
  copyShortcutLabel,
  setCopyToast,
  propsRef,
  copyToastTimeoutRef
}: {
  editorInstance: editor.IStandaloneCodeEditor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monaco: any
  filePath: string
  copyShortcutLabel: string
  setCopyToast: (toast: { left: number; top: number } | null) => void
  propsRef: React.MutableRefObject<{
    relativePath: string
    language: string
    onSave?: (content: string) => void
  }>
  copyToastTimeoutRef: React.MutableRefObject<number | null>
}): void {
  let copyHintInterval: number | null = null
  let copyHintWidgetPosition: editor.IContentWidgetPosition | null = null
  let lastCopiedSelectionKey: string | null = null
  const copyHintNode = document.createElement('div')
  copyHintNode.className =
    'pointer-events-none rounded-md border border-border/90 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-[0_6px_18px_rgba(15,23,42,0.18)] backdrop-blur whitespace-nowrap'
  copyHintNode.textContent = `Copy context ${copyShortcutLabel}`
  copyHintNode.style.display = 'none'
  const copyHintWidget: editor.IContentWidget = {
    allowEditorOverflow: true,
    suppressMouseDown: true,
    getId: () => `orca.copy-context-hint.${filePath}`,
    getDomNode: () => copyHintNode,
    getPosition: () => copyHintWidgetPosition
  }
  editorInstance.addContentWidget(copyHintWidget)

  const showCopyToast = (): void => {
    const selection = editorInstance.getSelection()
    if (!selection) {
      return
    }
    const visiblePosition = editorInstance.getScrolledVisiblePosition(selection.getEndPosition())
    const bounds = editorInstance.getContainerDomNode().getBoundingClientRect()
    setCopyToast({
      left: bounds.left + (visiblePosition?.left ?? bounds.width - 120),
      top: bounds.top + (visiblePosition?.top ?? 16) + (visiblePosition?.height ?? 20) + 8
    })
    if (copyToastTimeoutRef.current !== null) {
      window.clearTimeout(copyToastTimeoutRef.current)
    }
    copyToastTimeoutRef.current = window.setTimeout(() => {
      setCopyToast(null)
      copyToastTimeoutRef.current = null
    }, 1200)
  }

  const getSelectionKey = (): string | null => {
    const selection = editorInstance.getSelection()
    if (!selection) {
      return null
    }

    return [
      selection.startLineNumber,
      selection.startColumn,
      selection.endLineNumber,
      selection.endColumn
    ].join(':')
  }

  const updateCopyHint = (): void => {
    const contextualCopyText = getContextualCopyText()
    if (!contextualCopyText) {
      copyHintNode.style.display = 'none'
      copyHintWidgetPosition = null
      editorInstance.layoutContentWidget(copyHintWidget)
      return
    }

    if (lastCopiedSelectionKey !== null && lastCopiedSelectionKey === getSelectionKey()) {
      copyHintNode.style.display = 'none'
      copyHintWidgetPosition = null
      editorInstance.layoutContentWidget(copyHintWidget)
      return
    }

    const model = editorInstance.getModel()
    const selection = editorInstance.getSelection()
    if (!model || !selection) {
      copyHintNode.style.display = 'none'
      copyHintWidgetPosition = null
      editorInstance.layoutContentWidget(copyHintWidget)
      return
    }

    const { startLine, endLine } = getContextualCopyLineRange(selection)
    const startVisiblePosition = editorInstance.getScrolledVisiblePosition(
      selection.getStartPosition()
    )
    const endColumn =
      selection.endLineNumber === endLine ? selection.endColumn : model.getLineMaxColumn(endLine)
    const endVisiblePosition = editorInstance.getScrolledVisiblePosition({
      lineNumber: endLine,
      column: endColumn
    })

    if (!startVisiblePosition || !endVisiblePosition) {
      copyHintNode.style.display = 'none'
      copyHintWidgetPosition = null
      editorInstance.layoutContentWidget(copyHintWidget)
      return
    }

    const hintHeight = copyHintNode.offsetHeight || 28
    const verticalGap = 8
    const viewportHeight = editorInstance.getLayoutInfo().height
    const selectionTop = startVisiblePosition.top
    const selectionBottom = endVisiblePosition.top + endVisiblePosition.height
    const spaceAbove = selectionTop
    const spaceBelow = viewportHeight - selectionBottom
    const placeAbove = spaceAbove >= hintHeight + verticalGap || spaceAbove >= spaceBelow
    const anchorLineNumber = placeAbove ? startLine : endLine
    const anchorColumn = placeAbove
      ? model.getLineMaxColumn(startLine)
      : selection.endLineNumber !== endLine
        ? model.getLineMaxColumn(endLine)
        : selection.endColumn

    copyHintWidgetPosition = {
      position: { lineNumber: anchorLineNumber, column: anchorColumn },
      secondaryPosition: {
        lineNumber: anchorLineNumber,
        column: Math.max(1, anchorColumn - 1)
      },
      preference: [
        placeAbove
          ? monaco.editor.ContentWidgetPositionPreference.ABOVE
          : monaco.editor.ContentWidgetPositionPreference.BELOW
      ]
    }
    copyHintNode.style.display = 'block'
    editorInstance.layoutContentWidget(copyHintWidget)
  }

  const startCopyHintPolling = (): void => {
    updateCopyHint()
    if (copyHintInterval !== null) {
      return
    }
    copyHintInterval = window.setInterval(() => {
      updateCopyHint()
    }, 150)
  }

  const stopCopyHintPolling = (): void => {
    if (copyHintInterval !== null) {
      window.clearInterval(copyHintInterval)
      copyHintInterval = null
    }
  }

  const getContextualCopyText = (): string | null => {
    const model = editorInstance.getModel()
    const selection = editorInstance.getSelection()
    if (!model || !selection || selection.isEmpty()) {
      return null
    }

    return formatCopiedSelectionWithContext({
      relativePath: propsRef.current.relativePath,
      language: propsRef.current.language,
      selection,
      selectedText: model.getValueInRange(selection)
    })
  }

  const copySelectionWithContext = async (): Promise<boolean> => {
    const copiedText = getContextualCopyText()
    if (!copiedText) {
      return false
    }

    // Why: terminal agents only receive pasted plain text. We write the
    // contextual payload at copy time so file and line metadata survives
    // once the snippet leaves Orca and is pasted into a terminal.
    await window.api.ui.writeClipboardText(copiedText)
    // Why: once the user has copied this exact selection, surfacing the
    // affordance again during the confirmation toast reads like duplicate
    // UI. We keep it suppressed until the selection actually changes.
    lastCopiedSelectionKey = getSelectionKey()
    copyHintNode.style.display = 'none'
    copyHintWidgetPosition = null
    editorInstance.layoutContentWidget(copyHintWidget)
    showCopyToast()
    return true
  }

  const isContextualCopyShortcut = (event: KeyboardEvent): boolean => {
    const isMac = navigator.userAgent.includes('Mac')
    const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
    return mod && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c'
  }

  editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC, () => {
    void copySelectionWithContext()
  })

  editorInstance.onDidChangeCursorSelection(() => {
    if (getSelectionKey() !== lastCopiedSelectionKey) {
      lastCopiedSelectionKey = null
    }
    updateCopyHint()
  })
  editorInstance.onDidScrollChange(() => {
    updateCopyHint()
  })
  editorInstance.onDidFocusEditorText(() => {
    startCopyHintPolling()
  })
  editorInstance.onDidBlurEditorText(() => {
    stopCopyHintPolling()
    copyHintNode.style.display = 'none'
    copyHintWidgetPosition = null
    editorInstance.layoutContentWidget(copyHintWidget)
  })

  const editorDomNode = editorInstance.getContainerDomNode()
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isContextualCopyShortcut(event)) {
      return
    }

    // Why: Monaco and Chromium can claim some Cmd/Ctrl+Shift shortcuts before the Monaco
    // command callback runs. Capturing the shortcut on the editor DOM keeps the
    // contextual-copy action reliable without changing native Cmd/Ctrl+C.
    event.preventDefault()
    event.stopPropagation()
    void copySelectionWithContext()
  }
  editorDomNode.addEventListener('keydown', handleKeyDown, true)
  editorDomNode.addEventListener('mouseup', updateCopyHint, true)
  editorDomNode.addEventListener('keyup', updateCopyHint, true)
  editorInstance.onDidDispose(() => {
    editorDomNode.removeEventListener('keydown', handleKeyDown, true)
    editorDomNode.removeEventListener('mouseup', updateCopyHint, true)
    editorDomNode.removeEventListener('keyup', updateCopyHint, true)
    stopCopyHintPolling()
    editorInstance.removeContentWidget(copyHintWidget)
  })
  if (editorInstance.hasTextFocus()) {
    startCopyHintPolling()
  } else {
    updateCopyHint()
  }
}
