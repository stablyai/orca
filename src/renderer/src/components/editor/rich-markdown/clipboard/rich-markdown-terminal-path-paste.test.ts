// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { shouldPasteTerminalWindowsPathAsPlainText } from './rich-markdown-terminal-path-paste'

describe('shouldPasteTerminalWindowsPathAsPlainText', () => {
  it.each([
    'Read C:\\Users\\My Project\\README.md before editing.',
    'Review \\\\build-server\\Team Docs\\README.md with the release notes.',
    'Open \\\\server\\README.md before editing.',
    'Open C:\\Users\\My Project\\README.md.',
    '"path": "C:\\\\Users\\\\My Project\\\\README.md"'
  ])('detects the linked basename in %s', (plainText) => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText,
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(true)
  })

  it.each([
    'Open C:\\Users\\README.md.backup before editing.',
    'Open C:\\Users\\README.md,backup before editing.',
    'Open C:\\Users\\NOTES.txt and review README.md before editing.',
    'Open C:\\docs\\notes.txt and /README.md before editing.',
    'Install to C:/Tools then read docs/README.md before editing.'
  ])('does not match a different basename in %s', (plainText) => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText,
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(false)
  })
})
