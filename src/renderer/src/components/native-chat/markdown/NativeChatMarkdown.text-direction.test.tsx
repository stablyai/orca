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
})
