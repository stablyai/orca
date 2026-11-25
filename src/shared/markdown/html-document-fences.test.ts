import { describe, expect, it } from 'vitest'
import { splitHtmlDocumentFences } from './html-document-fences'

describe('splitHtmlDocumentFences', () => {
  it('takes out only whole-page html fences and keeps every other line', () => {
    const text = [
      'Here is the page:',
      '',
      '```html',
      '<!DOCTYPE html>',
      '<html><body>````nested````</body></html>',
      '```',
      '',
      'A snippet stays:',
      '```html',
      '<div>hi</div>',
      '```',
      '~~~HTML',
      '<html lang="en"></html>',
      '~~~',
      '```html',
      '<!doctype html><p>unclosed'
    ].join('\n')
    expect(splitHtmlDocumentFences(text)).toEqual({
      text: [
        'Here is the page:',
        '',
        'A snippet stays:',
        '```html',
        '<div>hi</div>',
        '```',
        '```html',
        '<!doctype html><p>unclosed'
      ].join('\n'),
      documents: [
        '<!DOCTYPE html>\n<html><body>````nested````</body></html>',
        '<html lang="en"></html>'
      ]
    })
  })
})
