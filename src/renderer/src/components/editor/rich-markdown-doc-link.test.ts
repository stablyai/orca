import { describe, expect, it } from 'vitest'
import { isDocLinkLiteralCodeTextNode } from './rich-markdown-doc-link-code-context'

function textContext(markNames: string[] = []) {
  return {
    marks: markNames.map((name) => ({ type: { name } }))
  }
}

function parentContext(code: boolean) {
  return {
    type: {
      spec: { code }
    }
  }
}

describe('isDocLinkLiteralCodeTextNode', () => {
  it('allows doc link conversion in ordinary prose text', () => {
    expect(isDocLinkLiteralCodeTextNode(textContext(), parentContext(false))).toBe(false)
  })

  it('skips doc link conversion for inline code marks', () => {
    expect(isDocLinkLiteralCodeTextNode(textContext(['code']), parentContext(false))).toBe(true)
  })

  it('skips doc link conversion for fenced code block text', () => {
    expect(isDocLinkLiteralCodeTextNode(textContext(), parentContext(true))).toBe(true)
  })
})
