import { describe, expect, it } from 'vitest'
import { splitHtmlDocumentFences } from './html-document-fences'

describe('splitHtmlDocumentFences', () => {
  it('takes out only whole-page html fences and keeps every other line as written', () => {
    const text = [
      '  Indented first line',
      'Here is the page:',
      '',
      '```html',
      '<!DOCTYPE html>',
      '<html><body>````nested````</body></html>',
      '```',
      '',
      '',
      'A snippet and other code stay:',
      '```html',
      '<div>hi</div>',
      '```',
      '```python',
      'x = 1',
      '',
      '',
      '',
      'y = 2',
      '```',
      '~~~HTML',
      '<html lang="en"></html>',
      '~~~',
      '```html',
      '<!doctype html><p>unclosed'
    ].join('\n')
    expect(splitHtmlDocumentFences(text)).toEqual({
      text: [
        '  Indented first line',
        'Here is the page:',
        '',
        'A snippet and other code stay:',
        '```html',
        '<div>hi</div>',
        '```',
        '```python',
        'x = 1',
        '',
        '',
        '',
        'y = 2',
        '```',
        '',
        '```html',
        '<!doctype html><p>unclosed'
      ].join('\n'),
      documents: [
        '<!DOCTYPE html>\n<html><body>````nested````</body></html>',
        '<html lang="en"></html>'
      ]
    })
  })

  it('finds a page in CRLF text', () => {
    const split = splitHtmlDocumentFences('Page:\r\n```html\r\n<html></html>\r\n```\r\nDone.')
    expect(split.documents).toEqual(['<html></html>\r'])
    expect(split.text).toBe('Page:\r\n\nDone.')
  })
})
