import { describe, expect, it } from 'vitest'
import { linkGitHubReferences } from './github-reference-links'

type Node = {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: Node[]
}

const DEFAULT_REPO = { owner: 'acme', repo: 'widgets' }

function textNode(value: string): Node {
  return { type: 'text', value }
}

function issueLink(url: string, label: string): Node {
  return { type: 'link', url, title: null, children: [textNode(label)] }
}

function linkText(value: string): Node[] | undefined {
  const tree: Node = { type: 'paragraph', children: [textNode(value)] }
  linkGitHubReferences(tree, DEFAULT_REPO)
  return tree.children
}

describe('linkGitHubReferences', () => {
  it('leaves a bare issue number as plain text', () => {
    expect(linkText('#11854')).toEqual([textNode('#11854')])
  })

  it('links an owner/repo-qualified reference', () => {
    expect(linkText('other/project#11854')).toEqual([
      issueLink('https://github.com/other/project/issues/11854', 'other/project#11854')
    ])
  })

  it('leaves a repo-only reference as plain text', () => {
    expect(linkText('widgets#11854')).toEqual([textNode('widgets#11854')])
  })

  it('leaves an embedded reference as plain text', () => {
    expect(linkText('abc#11854')).toEqual([textNode('abc#11854')])
  })

  it('links only the qualified references in mixed text', () => {
    expect(linkText('Fixes #12 in other/project#34 and widgets#56.')).toEqual([
      textNode('Fixes #12 in '),
      issueLink('https://github.com/other/project/issues/34', 'other/project#34'),
      textNode(' and widgets#56.')
    ])
  })
})
