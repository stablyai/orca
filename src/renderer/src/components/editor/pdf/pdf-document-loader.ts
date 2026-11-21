import * as pdfjsLib from 'pdfjs-dist'
import { buildPdfJsDocumentOptions } from './pdf-js-document-options'
import { createOrcaMediaRangeTransport } from './pdf-orca-media-range-transport'
import { translate } from '@/i18n/i18n'

type PdfLoadingTask = ReturnType<typeof pdfjsLib.getDocument>

/** Bytes (raw or base64), or an orca-media URL (with its size) pdf.js reads by range. */
export type PdfDocumentSource =
  | { bytes: Uint8Array }
  | { base64: string }
  | { url: string; length?: number }

export type PdfDocumentLoader = {
  load: (source: PdfDocumentSource) => void
  dispose: () => void
}

export function createPdfDocumentLoader({
  display,
  onError
}: {
  /** Its detach may return a promise; the document stays alive until it settles. */
  display: (doc: pdfjsLib.PDFDocumentProxy) => () => Promise<void> | void
  onError: (message: string | null) => void
}): PdfDocumentLoader {
  const tasks = new Set<PdfLoadingTask>()
  let pending: PdfLoadingTask | null = null
  let displayed: { task: PdfLoadingTask; detach: () => Promise<void> | void } | null = null
  let disposed = false

  const destroy = (task: PdfLoadingTask, after?: Promise<void> | void): void => {
    if (tasks.delete(task)) {
      void Promise.resolve(after)
        .catch(() => {})
        .then(() => task.destroy())
        .catch(() => {})
    }
  }
  const fail = (error: unknown): void => {
    onError(
      error instanceof Error && error.name === 'PasswordException'
        ? translate(
            'auto.components.editor.PdfViewer.passwordProtected',
            'This PDF is password-protected'
          )
        : pdfLoadFailedMessage()
    )
  }

  return {
    load: (source) => {
      if (disposed) {
        return
      }
      if (pending) {
        destroy(pending)
        pending = null
      }
      const previous = displayed
      displayed = null
      let detached: Promise<void> | void = undefined
      try {
        // Why: flush the reader's position before the replacement restores it.
        detached = previous?.detach()
      } finally {
        if (previous) {
          destroy(previous.task, detached)
        }
      }
      onError(null)
      // Bound to the task once it exists: a failed range tears down that load, not just its message.
      let failRange: (error: unknown) => void = fail
      const documentSource =
        'url' in source
          ? source.length
            ? {
                range: createOrcaMediaRangeTransport(source.url, source.length, (error) =>
                  failRange(error)
                )
              }
            : // orca-media refuses fetch, so a URL is only readable through its sized range transport.
              pdfLoadFailedMessage()
          : 'bytes' in source
            ? // pdf.js transfers the buffer to its worker; the caller keeps its own copy.
              { data: source.bytes.slice() }
            : decodePdfBase64(source.base64)
      if (typeof documentSource === 'string') {
        onError(documentSource)
        return
      }
      let task: PdfLoadingTask
      try {
        task = pdfjsLib.getDocument(buildPdfJsDocumentOptions(documentSource, document.baseURI))
      } catch (error) {
        fail(error)
        return
      }
      tasks.add(task)
      pending = task
      failRange = (error) => {
        if (disposed || !tasks.has(task)) {
          return
        }
        if (pending === task) {
          pending = null
        }
        const shown = displayed?.task === task ? displayed : null
        try {
          shown?.detach()
        } finally {
          if (shown) {
            displayed = null
          }
          destroy(task)
          fail(error)
        }
      }
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
      const shown = displayed
      let detached: Promise<void> | void = undefined
      try {
        detached = shown?.detach()
      } finally {
        displayed = null
        for (const task of tasks) {
          destroy(task, task === shown?.task ? detached : undefined)
        }
      }
    }
  }
}

function pdfLoadFailedMessage(): string {
  return translate('auto.components.editor.PdfViewer.loadFailed', 'Failed to load PDF preview')
}

function decodePdfBase64(content: string): { data: Uint8Array } | string {
  if (!content) {
    return pdfLoadFailedMessage()
  }
  let binary: string
  try {
    binary = window.atob(content)
  } catch {
    return translate(
      'auto.components.editor.PdfViewer.decodeFailed',
      'Failed to decode PDF content'
    )
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return { data: bytes }
}
