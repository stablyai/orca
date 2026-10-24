import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const content =
  '**单算 Runtime 执行引擎，平均每题 29.78 秒。**边界是开始执行到产出结果，已排除评测证据采集、评分和后续资源清理。'

describe('native chat CJK emphasis', () => {
  it.each(['**平均每题 29.78 秒。** 边界', '**平均每题 29.78 秒**。边界'])(
    'already renders an unambiguous boundary: %s',
    (text) => {
      expect(
        renderToStaticMarkup(<NativeChatMarkdown content={text} variant="document" />)
      ).toContain('<strong>平均每题 29.78 秒')
    }
  )

  it('renders the complete bold sentence before adjacent Chinese prose', () => {
    const markup = renderToStaticMarkup(<NativeChatMarkdown content={content} variant="document" />)
    expect(markup).toContain('<strong>单算 Runtime 执行引擎，平均每题 29.78 秒。</strong>边界')
    expect(markup).not.toContain('**')
  })

  it.each([
    ['前文**（重点）**后文', '（重点）'],
    ['これは**重要。**続き', '重要。'],
    ['문장**중요。**계속', '중요。']
  ])('renders CJK punctuation boundaries: %s', (text, bold) => {
    const markup = renderToStaticMarkup(<NativeChatMarkdown content={text} variant="document" />)
    expect(markup).toContain(`<strong>${bold}</strong>`)
  })

  it.each([
    '`**重点。**后文`',
    '```text\n**重点。**后文\n```',
    '\\*\\*重点。\\*\\*后文',
    'a**b.**c'
  ])('keeps literal text and non-CJK boundaries: %s', (text) => {
    const markup = renderToStaticMarkup(<NativeChatMarkdown content={text} variant="document" />)
    expect(markup).not.toContain('<strong>')
  })

  it('keeps emphasis while a response is growing', () => {
    const markup = renderToStaticMarkup(
      <NativeChatMarkdown content={content} variant="document" growing />
    )
    expect(markup).toContain('<strong>单算 Runtime 执行引擎，平均每题 29.78 秒。</strong>边界')
  })
})
