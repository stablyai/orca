import type { Editor } from '@tiptap/react'
import { escapeRegex } from '../../../../../../shared/string-utils'

const WINDOWS_PATH_ROOT = /(?:[A-Za-z]:[\\/]+|\\\\[^\s\\/:*?"<>|]+\\+)/
// Separator runs cover escaped paths; spaced folders must be backslash-delimited so "C:\App and docs/README.md" stays rich.
const WINDOWS_PATH_FOLDERS =
  /(?:[^\s<>:"|?*\\/]+[\\/]+|(?<=\\)[^\s<>:"|?*\\/]*[^\S\r\n][^<>:"|?*\\/\r\n]*\\+)*/.source
const WINDOWS_BASENAME_END = /\.?(?=$|[\s<>:"|?*])/.source

function readClipboardText(event: ClipboardEvent, type: string): string {
  return event.clipboardData?.getData(type) ?? ''
}

function extractClipboardAnchorHrefs(html: string): string[] {
  if (!html || typeof DOMParser === 'undefined') {
    return []
  }

  const document = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(
    document.querySelectorAll('a[href]'),
    (anchor) => anchor.getAttribute('href') ?? ''
  )
}

function getHttpHostname(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol.startsWith('http') ? url.hostname : null
  } catch {
    return null
  }
}

export function shouldPasteTerminalWindowsPathAsPlainText({
  plainText,
  htmlText
}: {
  plainText: string
  htmlText: string
}): boolean {
  if (!WINDOWS_PATH_ROOT.test(plainText)) {
    return false
  }

  const hostnames = new Set(
    extractClipboardAnchorHrefs(htmlText).flatMap((href) => getHttpHostname(href) ?? [])
  )
  if (hostnames.size === 0) {
    return false
  }

  const basenames = Array.from(hostnames, escapeRegex).join('|')
  return new RegExp(
    `${WINDOWS_PATH_ROOT.source}${WINDOWS_PATH_FOLDERS}(?:${basenames})${WINDOWS_BASENAME_END}`,
    'i'
  ).test(plainText)
}

export function handleRichMarkdownTerminalPathPaste(
  editor: Editor | null,
  event: ClipboardEvent
): boolean {
  if (event.defaultPrevented || !editor) {
    return false
  }

  const plainText = readClipboardText(event, 'text/plain')
  if (!plainText) {
    return false
  }

  if (
    !shouldPasteTerminalWindowsPathAsPlainText({
      plainText,
      htmlText: readClipboardText(event, 'text/html')
    })
  ) {
    return false
  }

  event.preventDefault()
  // Use clipboard plain text because synthetic terminal basename URLs lose Windows path information.
  editor.view.dispatch(editor.state.tr.insertText(plainText))
  return true
}
