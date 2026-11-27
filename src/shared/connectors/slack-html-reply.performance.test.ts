import { afterEach, expect, it, vi } from 'vitest'
import { splitSlackHtmlReply } from './slack-html-reply'
import * as slackText from './slack-local-paths'

afterEach(() => {
  vi.restoreAllMocks()
})

// PR #49449: replies over the attachment limit skip per-page formatting before going inline.
it.each([8_192, 81_920])('checks only attachable pages at %i characters per page', (width) => {
  const paragraph = '[report](https://example.invalid/(archive))'.padEnd(width, 'x')
  const page = ['```html', `<html><p>${paragraph}</p></html>`, '```'].join('\n')
  const tenPages = Array<string>(10).fill(page).join('\n\n')
  const formatPage = vi.spyOn(slackText, 'redactLocalPaths')

  expect(splitSlackHtmlReply(tenPages)?.documents).toHaveLength(10)
  expect(formatPage).toHaveBeenCalledTimes(10)

  formatPage.mockClear()
  expect(splitSlackHtmlReply(`${tenPages}\n\n${page}`)).toBeNull()
  expect(formatPage).not.toHaveBeenCalled()
})
