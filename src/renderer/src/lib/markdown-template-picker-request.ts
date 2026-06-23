import type { MarkdownDocumentTemplate } from './markdown-document-templates'

export type MarkdownTemplateSelection =
  | { type: 'blank' }
  | { type: 'template'; template: MarkdownDocumentTemplate }
  | { type: 'cancel' }

export type MarkdownTemplatePickerRequest = {
  id: string
  templates: MarkdownDocumentTemplate[]
  resolve: (selection: MarkdownTemplateSelection) => void
}

type MarkdownTemplatePickerListener = (request: MarkdownTemplatePickerRequest) => void

let listener: MarkdownTemplatePickerListener | null = null
let nextRequestId = 0

function once<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let called = false
  return (...args: T) => {
    if (called) {
      return
    }
    called = true
    fn(...args)
  }
}

export function subscribeMarkdownTemplatePicker(
  nextListener: MarkdownTemplatePickerListener
): () => void {
  listener = nextListener
  return () => {
    if (listener === nextListener) {
      listener = null
    }
  }
}

export function requestMarkdownTemplateSelection(
  templates: MarkdownDocumentTemplate[]
): Promise<MarkdownTemplateSelection> {
  if (templates.length === 0 || !listener) {
    return Promise.resolve({ type: 'blank' })
  }

  return new Promise((resolve) => {
    listener?.({
      id: `markdown-template-${nextRequestId}`,
      templates,
      resolve: once(resolve)
    })
    nextRequestId += 1
  })
}
