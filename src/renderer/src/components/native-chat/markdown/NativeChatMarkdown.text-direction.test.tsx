import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NativeChatMarkdown } from '@/components/native-chat/markdown/NativeChatMarkdown'

function renderDocument(content: string): string {
  return renderToStaticMarkup(<NativeChatMarkdown content={content} variant="document" />)
}

describe('NativeChatMarkdown text direction', () => {
  it('lays out a mostly Arabic message right to left despite English terms and code', () => {
    const markup = renderDocument(
      'افتح ملف `index.html` ثم أعد تشغيل Orca الآن\n\n```\nnpm run build --watch\n```'
    )

    expect(markup).toMatch(/^<div[^>]* dir="rtl"/)
  })

  it('keeps an English paragraph and list left to right inside an Arabic message', () => {
    const markup = renderDocument(
      'هذه رسالة عربية طويلة بما يكفي لتكون أغلب الحروف فيها عربية، وفيها شرح كامل للخطوات المطلوبة\n\nThis paragraph is English.\n\n- First item\n- Second item'
    )

    expect(markup).toContain('<p dir="ltr"')
    expect(markup).toContain('<ul dir="ltr"')
  })

  it('marks an Arabic paragraph right to left inside an English message', () => {
    const markup = renderDocument('An English reply with one Arabic line:\n\nمرحبا بك في التطبيق')

    expect(markup).not.toMatch(/^<div[^>]* dir=/)
    expect(markup).toContain('<p dir="rtl"')
  })

  it('adds no direction attributes to a message without right-to-left text', () => {
    const markup = renderDocument('Plain English.\n\n- one\n- two')

    expect(markup).not.toContain('dir=')
    expect(markup).not.toContain('data-native-chat-bidi')
  })
  it('does not count Arabic-Indic digits as right-to-left letters', () => {
    expect(renderDocument('Build ١٢٣٤٥٦')).not.toContain('dir=')
  })

  it('lets Han prose outvote a short Arabic quote', () => {
    expect(renderDocument('請重新啟動應用程式 (مرحبا)')).not.toMatch(/^<div[^>]* dir="rtl"/)
  })

  it('ignores link destinations when voting', () => {
    expect(renderDocument('[مرحبا](https://example.com/documentation)')).toMatch(
      /^<div[^>]* dir="rtl"/
    )
  })

  it('keeps prose after a mid-line tilde run', () => {
    expect(renderDocument('Note ~~~\n\n- مرحبا بك في التطبيق')).toContain('dir="rtl"')
  })

  it('compares a nested English list with its Arabic parent list', () => {
    const markup = renderDocument(
      'An English reply with a list:\n\n- مرحبا بك في التطبيق\n  - OK fine\n  - Also fine'
    )
    expect(markup).toContain('<ul dir="rtl"')
    expect(markup).toContain('<ul dir="ltr"')
  })

  it('honors an explicit dir prop', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown content="English text" variant="document" dir="rtl" />
    )
    expect(markup).toMatch(/^<div[^>]* dir="rtl"/)
  })
})
