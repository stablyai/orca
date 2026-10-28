import type { editor } from 'monaco-editor'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { monaco } from '@/lib/monaco-setup'
import { useAppStore } from '@/store'
import { editorShortcutMatches } from './editor-shortcuts'
import {
  canCopySelectionWithContext,
  formatCopiedSelectionWithContext,
  getContextualCopyLineRange
} from './selection-copy'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  isPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'

export function setupContextualCopy({
  editorInstance,
  filePath,
  setCopyToast,
  propsRef,
  copyToastTimeoutRef
}: {
  editorInstance: editor.IStandaloneCodeEditor
  filePath: string
  setCopyToast: (toast: { left: number; top: number } | null) => void
  propsRef: React.MutableRefObject<{
    relativePath: string
    language: string
    onSave?: (content: string) => void
  }>
  copyToastTimeoutRef: React.MutableRefObject<number | null>
}): void {
  let copyHintInterval: number | null = null
  let primarySelectionTimer: number | null = null
  let copyHintWidgetPosition: editor.IContentWidgetPosition | null = null
  let lastCopiedSelectionKey: string | null = null
  const copyHintNode = document.createElement('div')
  copyHintNode.className =
    'pointer-events-none rounded-md border border-border/90 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-[0_6px_18px_rgba(15,23,42,0.18)] backdrop-blur whitespace-nowrap'
  const updateCopyHintLabel = (): void => {
    copyHintNode.textContent = `Copy context ${formatShortcutLabel(
      'editor.copyContext',
      useAppStore.getState().keybindings
    )}`
  }
  updateCopyHintLabel()
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
    updateCopyHintLabel()
    const model = editorInstance.getModel()
    const selection = editorInstance.getSelection()
    // Why: hint ticks need selection bounds; extracting the selected text scales with file size.
    if (!model || !selection || selection.isEmpty() || !canCopySelectionWithContext(selection)) {
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

  const isCopyHintVisible = (): boolean => copyHintNode.style.display === 'block'

  const startCopyHintPolling = (): void => {
    if (copyHintInterval !== null) {
      return
    }
    copyHintInterval = window.setInterval(() => {
      updateCopyHint()
      if (!isCopyHintVisible()) {
        stopCopyHintPolling()
      }
    }, 150)
  }

  const stopCopyHintPolling = (): void => {
    if (copyHintInterval !== null) {
      window.clearInterval(copyHintInterval)
      copyHintInterval = null
    }
  }

  const refreshCopyHintAndPolling = (): void => {
    updateCopyHint()
    if (editorInstance.hasTextFocus() && isCopyHintVisible()) {
      // Poll only visible hints; selection-free focused editors otherwise burn idle CPU.
      startCopyHintPolling()
    } else {
      stopCopyHintPolling()
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

  const updatePrimarySelectionBuffer = (): void => {
    const model = editorInstance.getModel()
    const selections = editorInstance.getSelections()
    if (!isPrimarySelectionEnabled() || !model || !selections?.length) {
      return
    }

    const sortedSelections = selections.slice().sort((a, b) => {
      if (a.startLineNumber !== b.startLineNumber) {
        return a.startLineNumber - b.startLineNumber
      }
      return a.startColumn - b.startColumn
    })

    let totalLength = 0
    for (const selection of sortedSelections) {
      if (selection.isEmpty()) {
        return
      }
      totalLength += model.getValueLengthInRange(selection)
      if (totalLength > PRIMARY_SELECTION_MAX_LENGTH) {
        return
      }
    }

    setPrimarySelectionText(
      sortedSelections.map((selection) => model.getValueInRange(selection)).join(model.getEOL())
    )
  }

  const schedulePrimarySelectionBufferUpdate = (): void => {
    if (primarySelectionTimer !== null) {
      window.clearTimeout(primarySelectionTimer)
    }
    // Debounce intermediate drag selections like the editor selection clipboard to avoid clipboard churn.
    primarySelectionTimer = window.setTimeout(() => {
      primarySelectionTimer = null
      updatePrimarySelectionBuffer()
    }, 100)
  }

  const copySelectionWithContext = async (): Promise<boolean> => {
    const copiedText = getContextualCopyText()
    if (!copiedText) {
      return false
    }

    // Embed file/line context at copy time because terminal agents receive plain text only.
    await window.api.ui.writeClipboardText(copiedText)
    // Suppress the hint for this selection after copying so it does not duplicate the confirmation toast.
    lastCopiedSelectionKey = getSelectionKey()
    copyHintNode.style.display = 'none'
    copyHintWidgetPosition = null
    editorInstance.layoutContentWidget(copyHintWidget)
    showCopyToast()
    return true
  }

  const selectionListener = editorInstance.onDidChangeCursorSelection((event) => {
    if (event.source !== 'restoreState') {
      schedulePrimarySelectionBufferUpdate()
    }
    if (getSelectionKey() !== lastCopiedSelectionKey) {
      lastCopiedSelectionKey = null
    }
    refreshCopyHintAndPolling()
  })
  const scrollListener = editorInstance.onDidScrollChange(() => {
    refreshCopyHintAndPolling()
  })
  const focusListener = editorInstance.onDidFocusEditorText(() => {
    refreshCopyHintAndPolling()
  })
  const blurListener = editorInstance.onDidBlurEditorText(() => {
    stopCopyHintPolling()
    copyHintNode.style.display = 'none'
    copyHintWidgetPosition = null
    editorInstance.layoutContentWidget(copyHintWidget)
  })

  const editorDomNode = editorInstance.getContainerDomNode()
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.copyContext', event)) {
      return
    }

    // Capture before Monaco/Chromium claim the chord; preserve ordinary native copy.
    event.preventDefault()
    event.stopPropagation()
    void copySelectionWithContext()
  }
  editorDomNode.addEventListener('keydown', handleKeyDown, true)
  editorDomNode.addEventListener('mouseup', refreshCopyHintAndPolling, true)
  editorDomNode.addEventListener('keyup', refreshCopyHintAndPolling, true)
  editorInstance.onDidDispose(() => {
    selectionListener.dispose()
    scrollListener.dispose()
    focusListener.dispose()
    blurListener.dispose()
    // Clear the toast timer when its owning Monaco editor is disposed.
    if (copyToastTimeoutRef.current !== null) {
      window.clearTimeout(copyToastTimeoutRef.current)
      copyToastTimeoutRef.current = null
      setCopyToast(null)
    }
    if (primarySelectionTimer !== null) {
      window.clearTimeout(primarySelectionTimer)
      primarySelectionTimer = null
    }
    editorDomNode.removeEventListener('keydown', handleKeyDown, true)
    editorDomNode.removeEventListener('mouseup', refreshCopyHintAndPolling, true)
    editorDomNode.removeEventListener('keyup', refreshCopyHintAndPolling, true)
    stopCopyHintPolling()
    editorInstance.removeContentWidget(copyHintWidget)
  })
  if (editorInstance.hasTextFocus()) {
    refreshCopyHintAndPolling()
  } else {
    updateCopyHint()
  }
}
