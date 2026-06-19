export type DictationInsertionTarget =
  | { kind: 'terminal'; tabId: string; paneId: number }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contentEditable'; element: HTMLElement }

export function captureInsertionTarget(): DictationInsertionTarget | null {
  const activeElement = document.activeElement

  if (!activeElement) {
    return null
  }

  if (activeElement.classList.contains('xterm-helper-textarea')) {
    const paneElement = activeElement.closest('.pane[data-pane-id]') as HTMLElement | null
    const tabElement = activeElement.closest('[data-terminal-tab-id]') as HTMLElement | null
    const paneId = Number(paneElement?.dataset.paneId)
    const tabId = tabElement?.dataset.terminalTabId
    if (tabId && Number.isFinite(paneId)) {
      return { kind: 'terminal', tabId, paneId }
    }
    return null
  }

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    return { kind: 'text', element: activeElement }
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return { kind: 'contentEditable', element: activeElement }
  }

  return null
}

export function insertText(text: string, target: DictationInsertionTarget): void {
  if (target.kind === 'terminal') {
    document.dispatchEvent(
      new CustomEvent('dictation:insertText', {
        detail: { text, tabId: target.tabId, paneId: target.paneId }
      })
    )
    return
  }

  if (target.kind === 'text') {
    const element = target.element
    if (!element.isConnected) {
      return
    }
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? start
    element.setRangeText(text, start, end, 'end')
    element.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  if (target.kind === 'contentEditable') {
    const element = target.element
    if (!element.isConnected || !element.contains(document.activeElement)) {
      return
    }
    const editorElement = findClosestEditorElement(element) ?? element
    editorElement.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      })
    )
    if (!document.execCommand('insertText', false, text)) {
      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        const textNode = document.createTextNode(text)
        range.insertNode(textNode)
        range.setStartAfter(textNode)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      editorElement.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      )
    }
  }
}

function findClosestEditorElement(element: HTMLElement): HTMLElement | null {
  return element.closest('.ProseMirror, [contenteditable="true"]')
}
