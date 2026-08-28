import { describe, expect, it } from 'vitest'
import { routeNativeChatHref } from './native-chat-href-routing'

describe('routeNativeChatHref', () => {
  it('classifies web and mail links', () => {
    expect(routeNativeChatHref('https://example.com/docs')).toEqual({
      kind: 'web',
      url: 'https://example.com/docs'
    })
    expect(routeNativeChatHref(' mailto:dev@example.com ')).toEqual({
      kind: 'web',
      url: 'mailto:dev@example.com'
    })
  })

  it('parses relative file hrefs and line fragments', () => {
    expect(routeNativeChatHref('docs/plan.md?plain=1#line-7')).toEqual({
      kind: 'file',
      pathText: 'docs/plan.md',
      line: 7
    })
    expect(routeNativeChatHref('docs/plan.md#usage')).toEqual({
      kind: 'file',
      pathText: 'docs/plan.md',
      line: null
    })
  })

  it('decodes relative and file URI paths', () => {
    expect(routeNativeChatHref('docs/release%20notes.md')).toEqual({
      kind: 'file',
      pathText: 'docs/release notes.md',
      line: null
    })
    expect(routeNativeChatHref('file:///Users/me/wt/My%20File.tsx#L12')).toEqual({
      kind: 'file',
      pathText: '/Users/me/wt/My File.tsx',
      line: 12
    })
  })

  it('keeps Windows drive paths out of the scheme filter', () => {
    expect(routeNativeChatHref(String.raw`C:\repo\src\index.ts`)).toEqual({
      kind: 'file',
      pathText: String.raw`C:\repo\src\index.ts`,
      line: null
    })
  })

  it('drops anchors, unknown schemes, malformed file URIs, and empty hrefs', () => {
    expect(routeNativeChatHref('#section')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref(undefined)).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('editor://file/x.ts')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('file:///tmp/%E0%A4%A.txt')).toEqual({ kind: 'none' })
  })
})
