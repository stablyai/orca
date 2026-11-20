import { expect, it } from 'vitest'
import {
  isNativeChatAttachmentPeekable,
  nativeChatAttachmentPeekText
} from './NativeChatAttachmentPeek'

const STORE = '/Users/x/.orca/agent-session-attachments/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'

it("peeks at a store file's first lines, and at an HTML file's title and first words", () => {
  const log = Array.from({ length: 12 }, (_, n) => `line ${n + 1}`).join('\n')
  expect(nativeChatAttachmentPeekText(`${STORE}/run.log`, log)).toBe(
    'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8'
  )
  const html =
    '<html><head><title>Install report</title><style>p{}</style></head><body><h1>3 passed</h1><script>x()</script><p>All&nbsp;green</p>'
  expect(nativeChatAttachmentPeekText(`${STORE}/report.html`, html)).toBe(
    'Install report\n3 passed All green'
  )
})

it('peeks only at text-like files in a chat attachment store', () => {
  expect(isNativeChatAttachmentPeekable(`${STORE}/run.log`)).toBe(true)
  expect(isNativeChatAttachmentPeekable(`${STORE}/visual-diff.pdf`)).toBe(false)
  expect(isNativeChatAttachmentPeekable('/Users/x/project/run.log')).toBe(false)
})
