import { formatNativeChatFileReference } from '@/components/native-chat/native-chat-composer-target'
import { attachResolvedPathsToActiveNativeChatComposer } from '@/components/native-chat/native-chat-composer-path-attach'

export function attachExplorerFileAsContext(
  filePath: string,
  connectionId?: string | null
): boolean {
  if (attachResolvedPathsToActiveNativeChatComposer([filePath], connectionId)) {
    return true
  }
  return insertFormattedFileReferenceIntoFocusedComposer(filePath)
}

function insertFormattedFileReferenceIntoFocusedComposer(filePath: string): boolean {
  const target = document.activeElement
  if (!(target instanceof HTMLTextAreaElement) || target.disabled || target.readOnly) {
    return false
  }
  const insertion = `${formatNativeChatFileReference(filePath)} `
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? start
  const next = `${target.value.slice(0, start)}${insertion}${target.value.slice(end)}`
  const caret = start + insertion.length
  target.focus()
  target.value = next
  target.setSelectionRange(caret, caret)
  target.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: insertion })
  )
  return true
}
