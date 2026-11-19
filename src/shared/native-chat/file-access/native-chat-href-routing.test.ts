import { describe, expect, it } from 'vitest'
import { routeNativeChatHref } from './native-chat-href-routing'

describe('routeNativeChatHref', () => {
  it('keeps Windows drive paths out of the scheme filter', () => {
    expect(routeNativeChatHref(String.raw`C:\repo\src\index.ts`)).toEqual({
      kind: 'file',
      pathText: String.raw`C:\repo\src\index.ts`,
      line: null
    })
  })

  it('reads a bare file name with a line suffix as a file, not a scheme', () => {
    expect(routeNativeChatHref('README.md:5')).toEqual({
      kind: 'file',
      pathText: 'README.md:5',
      line: null
    })
    expect(routeNativeChatHref('App.tsx:12:3')).toEqual({
      kind: 'file',
      pathText: 'App.tsx:12:3',
      line: null
    })
    expect(routeNativeChatHref('localhost:3000')).toEqual({ kind: 'none' })
  })

  it('drops anchors, unknown schemes, malformed file URIs, and empty hrefs', () => {
    expect(routeNativeChatHref('#section')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref(undefined)).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('editor://file/x.ts')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(routeNativeChatHref('file:///tmp/%E0%A4%A.txt')).toEqual({ kind: 'none' })
  })
})
