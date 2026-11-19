import { describe, expect, it } from 'vitest'
import {
  interceptAnnotateEscape,
  registerAnnotateEscapeInterceptor
} from './annotate-escape-interceptor'

describe('annotate Esc interceptor', () => {
  it("lets this page's open notes list take Esc once, and never another page's", () => {
    let open = true
    const unregister = registerAnnotateEscapeInterceptor('page-1', () => {
      open = false
      return true
    })

    expect(interceptAnnotateEscape('page-2')).toBe(false)
    expect(interceptAnnotateEscape('page-1')).toBe(true)
    expect(open).toBe(false)

    unregister()
    expect(interceptAnnotateEscape('page-1')).toBe(false)
  })
})
