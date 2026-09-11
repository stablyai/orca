import { act } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { promptTextContent, promptTextMap } from './native-chat-prompt-document'

export function promptEditor(element: HTMLElement): Editor {
  return (element as HTMLElement & { editor: Editor }).editor
}

export function promptValue(element: HTMLElement): string {
  return promptTextMap(promptEditor(element).state.doc).text
}

export function changePrompt(element: HTMLElement, value: string): void {
  act(() => {
    promptEditor(element).commands.setContent(promptTextContent(value))
  })
}
