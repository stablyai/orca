import * as pdfjsLib from 'pdfjs-dist'
import { buildPdfJsDocumentOptions } from './pdf-js-document-options'

type PdfLoadingTask = ReturnType<typeof pdfjsLib.getDocument>

export type PdfDocumentLoader = {
  load: (content: string) => void
  dispose: () => void
}

export function createPdfDocumentLoader({
  display,
  onError
}: {
  display: (doc: pdfjsLib.PDFDocumentProxy) => () => void
  onError: (message: string | null) => void
}): PdfDocumentLoader {
  const tasks = new Set<PdfLoadingTask>()
  let pending: PdfLoadingTask | null = null
  let displayed: { task: PdfLoadingTask; detach: () => void } | null = null
  let disposed = false

  const destroy = (task: PdfLoadingTask): void => {
    if (tasks.delete(task)) {
      void task.destroy().catch(() => {})
    }
  }
  const fail = (error: unknown): void => {
    onError(
      error instanceof Error && error.name === 'PasswordException'
        ? 'This PDF is password-protected'
        : 'Failed to load PDF preview'
    )
  }

  return {
    load: (content) => {
      if (disposed) {
        return
      }
      if (pending) {
        destroy(pending)
        pending = null
      }
      const previous = displayed
      displayed = null
      try {
        // Why: flush the reader's position before the replacement restores it.
        previous?.detach()
      } finally {
        if (previous) {
          destroy(previous.task)
        }
      }
      onError(null)
      if (!content) {
        onError('Failed to load PDF preview')
        return
      }
      let binary: string
      try {
        binary = window.atob(content)
      } catch {
        onError('Failed to decode PDF content')
        return
      }
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      let task: PdfLoadingTask
      try {
        task = pdfjsLib.getDocument(buildPdfJsDocumentOptions(bytes, document.baseURI))
      } catch (error) {
        fail(error)
        return
      }
      tasks.add(task)
      pending = task
      void task.promise.then(
        (doc) => {
          if (disposed || pending !== task) {
            return
          }
          pending = null
          try {
            displayed = { task, detach: display(doc) }
            onError(null)
          } catch (error) {
            destroy(task)
            fail(error)
          }
        },
        (error: unknown) => {
          if (disposed || pending !== task) {
            return
          }
          pending = null
          destroy(task)
          fail(error)
        }
      )
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      pending = null
      try {
        displayed?.detach()
      } finally {
        displayed = null
        for (const task of tasks) {
          destroy(task)
        }
      }
    }
  }
}
