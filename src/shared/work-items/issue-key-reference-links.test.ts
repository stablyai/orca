import { describe, expect, it } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { linkIssueKeyReferences } from './issue-key-reference-links'
import { parseLinearIssueUrl } from '../linear/linear-reference-links'

const references = new Map([
  ['ENG', 'https://linear.app/acme/issue/'],
  ['OPS', 'https://acme.atlassian.net/browse/']
])

type Node = { type: string; value?: string; url?: string; children?: Node[] }

function links(markdown: string): { url?: string; text: string }[] {
  const tree: Node = fromMarkdown(markdown)
  linkIssueKeyReferences(tree, references)
  const found: { url?: string; text: string }[] = []
  const text = (node: Node): string =>
    node.value ?? (node.children ?? []).map((child) => text(child)).join('')
  const walk = (node: Node): void => {
    if (node.type === 'link') {
      found.push({ url: node.url, text: text(node) })
      return
    }
    node.children?.forEach(walk)
  }
  walk(tree)
  return found
}

describe('linkIssueKeyReferences', () => {
  it('links known keys in prose, bold and lists, each to its own tracker', () => {
    expect(links('- **ENG-778:** moved to In Review. See OPS-6139.')).toEqual([
      { url: 'https://linear.app/acme/issue/ENG-778', text: 'ENG-778' },
      { url: 'https://acme.atlassian.net/browse/OPS-6139', text: 'OPS-6139' }
    ])
  })

  it('links a reference followed by an apostrophe or punctuation', () => {
    expect(links("ENG-778's description, then (OPS-1).")).toHaveLength(2)
  })

  it('leaves unknown keys, versions, paths and longer words alone', () => {
    expect(links('UTF-8, PHP-74, src/ENG-778, ABC-ENG-1, ENG-778x, ENG-0')).toEqual([])
  })

  it('links inline code only when it is exactly one reference', () => {
    expect(links('`ENG-804` and `git checkout ENG-804`')).toEqual([
      { url: 'https://linear.app/acme/issue/ENG-804', text: 'ENG-804' }
    ])
  })

  it('keeps explicit links as written', () => {
    expect(links('[ENG-803](https://linear.app/acme/issue/ENG-803/qa)')).toEqual([
      { url: 'https://linear.app/acme/issue/ENG-803/qa', text: 'ENG-803' }
    ])
  })

  it('links nothing without references', () => {
    const tree: Node = fromMarkdown('ENG-1')
    linkIssueKeyReferences(tree, new Map())
    expect(JSON.stringify(tree)).not.toContain('"link"')
  })
})

describe('parseLinearIssueUrl', () => {
  it('reads issue URLs with or without a slug', () => {
    expect(parseLinearIssueUrl('https://linear.app/acme/issue/ENG-803/qa-foo')).toEqual({
      orgUrlKey: 'acme',
      identifier: 'ENG-803'
    })
    expect(parseLinearIssueUrl('https://linear.app/acme/issue/ENG-1')?.identifier).toBe('ENG-1')
  })

  it('rejects other URLs', () => {
    expect(parseLinearIssueUrl('https://linear.app/acme/project/foo')).toBeNull()
    expect(parseLinearIssueUrl('https://evil.example/linear.app/x/issue/ENG-1')).toBeNull()
    expect(parseLinearIssueUrl(undefined)).toBeNull()
  })
})
