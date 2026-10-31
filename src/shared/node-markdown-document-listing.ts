import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import type { MarkdownDocument } from './filesystem-entry-types'
import { RipgrepFilenameDecoder } from './ripgrep-filename-decoder'
import { isRipgrepMissingCwdExit, ripgrepMissingCwdError } from './ripgrep-process-availability'
import { abortSignalReason } from './abort-signal-reason'
import { markdownDocumentFromRelativePath, isMarkdownDocumentName } from './markdown-document-paths'
import { joinSearchRoot } from './text-search-paths'
import {
  createMarkdownDocumentListingBudget,
  retainMarkdownDocument,
  MarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES
} from './markdown-document-listing-limits'

const MARKDOWN_LISTING_TIMEOUT_MS = 15_000
export const MARKDOWN_DOCUMENT_GLOB = '*.{[mM][dD],[mM][dD][xX],[mM][aA][rR][kK][dD][oO][wW][nN]}'
export const MARKDOWN_DOCUMENT_LISTING_ARGS = [
  '--files',
  '--hidden',
  '--no-ignore',
  '--no-config',
  '--null',
  '--path-separator',
  '/',
  // Keep case variants in --glob: --iglob is applied after exclusions and can reopen hidden folders.
  '--glob',
  MARKDOWN_DOCUMENT_GLOB,
  '--glob',
  '!**/.*/',
  '--glob',
  '**/.github/',
  '--glob',
  '!**/node_modules/',
  '.'
]

export function collectMarkdownDocuments(
  child: ChildProcessHandle,
  rootPath: string,
  windowsOutput = false,
  signal?: AbortSignal,
  options: { allowPartialListing?: boolean; stopProcess?: () => void } = {}
): Promise<MarkdownDocument[]> {
  return new Promise((resolveListing, reject) => {
    const filenameDecoder = new RipgrepFilenameDecoder((error) => finish(error), windowsOutput)
    const documents: MarkdownDocument[] = []
    const budget = createMarkdownDocumentListingBudget()
    let carry = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onStderr)
      child.stdout?.off('error', onError)
      child.stderr?.off('error', onError)
      child.off('close', onClose)
      child.off('error', onError)
      // A spawn or pipe error can arrive after a timeout has already settled the listing.
      child.on('error', ignoreLateError)
      child.stdout?.on('error', ignoreLateError)
      child.stderr?.on('error', ignoreLateError)
      signal?.removeEventListener('abort', onAbort)
      carry = ''
      if (error) {
        if (child.pid !== undefined) {
          try {
            if (options.stopProcess) {
              options.stopProcess()
            } else {
              child.kill('SIGKILL')
            }
          } catch {
            // The process may have exited before the timeout or stream error arrived.
          }
        }
        documents.length = 0
        child.stdout?.resume()
        child.stderr?.resume()
        reject(error)
      } else {
        resolveListing(documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath)))
      }
    }
    const onAbort = (): void => finish(abortSignalReason(signal!))
    const onError = (error: Error): void => finish(error)
    const onStderr = (chunk: string): void => {
      stderr = (stderr + chunk).slice(0, 4096)
    }
    const onData = (chunk: Buffer | string): void => {
      const decoded = filenameDecoder.decode(chunk)
      if (decoded === null) {
        return
      }
      carry += decoded
      let start = 0
      let end: number
      while ((end = carry.indexOf('\0', start)) !== -1) {
        const path = carry.slice(start, end)
        if (Buffer.byteLength(path) > MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES) {
          finish(new MarkdownDocumentListingCapacityError())
          return
        }
        if (!path.startsWith('./') || path.split('/').includes('..')) {
          finish(new Error('Invalid path in Markdown document listing'))
          return
        }
        if (isMarkdownDocumentName(path)) {
          const document = markdownDocumentFromRelativePath(rootPath, path.slice(2))
          if (document) {
            document.filePath = joinSearchRoot(rootPath, document.relativePath)
            try {
              retainMarkdownDocument(budget, document)
              documents.push(document)
            } catch (error) {
              finish(error instanceof Error ? error : new MarkdownDocumentListingCapacityError())
              return
            }
          }
        }
        start = end + 1
      }
      carry = carry.slice(start)
      if (Buffer.byteLength(carry) > MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES) {
        finish(new MarkdownDocumentListingCapacityError())
      }
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (isRipgrepMissingCwdExit(code)) {
        finish(ripgrepMissingCwdError(rootPath))
      } else if (
        signal ||
        (code !== 0 &&
          code !== 1 &&
          !(code === 2 && options.allowPartialListing && documents.length > 0))
      ) {
        finish(new Error(`Markdown document listing failed (${signal ?? code}): ${stderr.trim()}`))
      } else {
        if (!filenameDecoder.finish()) {
          return
        }
        finish(carry ? new Error('Incomplete path in Markdown document listing') : undefined)
      }
    }
    const timer = setTimeout(
      () => finish(new Error('Markdown document listing timed out')),
      MARKDOWN_LISTING_TIMEOUT_MS
    )
    timer.unref?.()
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onStderr)
    child.stdout?.on('error', onError)
    child.stderr?.on('error', onError)
    child.once('error', onError)
    child.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function ignoreLateError(): void {}
