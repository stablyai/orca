import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  createMarkdownDocumentIndex,
  getMarkdownDocLinkAnchor,
  remarkMarkdownDocLinks,
  resolveMarkdownDocLink,
  splitMarkdownDocLinkText
} from './markdown-doc-links'

type TestNode = {
  type: string
  value?: string
  url?: string
  children?: TestNode[]
}

const documents: MarkdownDocument[] = [
  {
    filePath: '/repo/docs/setup-guide.md',
    relativePath: 'docs/setup-guide.md',
    basename: 'setup-guide.md',
    name: 'setup-guide'
  },
  {
    filePath: '/repo/notes/README.MDX',
    relativePath: 'notes/README.MDX',
    basename: 'README.MDX',
    name: 'README'
  }
]

describe('splitMarkdownDocLinkText', () => {
  it('splits multiple doc links', () => {
    expect(splitMarkdownDocLinkText('[[one]] and [[two]]')).toEqual([
      { type: 'docLink', target: 'one', label: 'one' },
      { type: 'text', value: ' and ' },
      { type: 'docLink', target: 'two', label: 'two' }
    ])
  })

  it('leaves unsupported forms as text', () => {
    expect(splitMarkdownDocLinkText('[[]] [[doc|]] [[bad [target]] [[draft')).toEqual([
      { type: 'text', value: '[[]]' },
      { type: 'text', value: ' [[doc|]]' },
      { type: 'text', value: ' [[bad [target]]' },
      { type: 'text', value: ' [[draft' }
    ])
  })
})

describe('resolveMarkdownDocLink', () => {
  it('resolves heading anchors against the document target', () => {
    const index = createMarkdownDocumentIndex(documents)

    expect(resolveMarkdownDocLink('docs/setup-guide#Install steps', index)).toMatchObject({
      status: 'resolved',
      document: { relativePath: 'docs/setup-guide.md' }
    })
  })

  it('treats duplicate normalized basenames as ambiguous', () => {
    const index = createMarkdownDocumentIndex([
      ...documents,
      {
        filePath: '/repo/other/Setup-Guide.md',
        relativePath: 'other/Setup-Guide.md',
        basename: 'Setup-Guide.md',
        name: 'Setup-Guide'
      }
    ])

    expect(resolveMarkdownDocLink('setup-guide', index).status).toBe('ambiguous')
    expect(resolveMarkdownDocLink('docs/setup-guide', index).status).toBe('resolved')
  })

  it('prefers exact relative path over ambiguous extensionless match', () => {
    const index = createMarkdownDocumentIndex([
      {
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        basename: 'guide.md',
        name: 'guide'
      },
      {
        filePath: '/repo/docs/guide.mdx',
        relativePath: 'docs/guide.mdx',
        basename: 'guide.mdx',
        name: 'guide'
      }
    ])

    expect(resolveMarkdownDocLink('docs/guide.md', index)).toMatchObject({
      status: 'resolved',
      document: { relativePath: 'docs/guide.md' }
    })
    expect(resolveMarkdownDocLink('docs/guide.mdx', index)).toMatchObject({
      status: 'resolved',
      document: { relativePath: 'docs/guide.mdx' }
    })
    expect(resolveMarkdownDocLink('docs/guide', index).status).toBe('ambiguous')
  })

  it('normalizes Windows-style targets', () => {
    const result = resolveMarkdownDocLink(
      'docs\\setup-guide.md',
      createMarkdownDocumentIndex(documents)
    )
    expect(result.status).toBe('resolved')
  })
})

describe('getMarkdownDocLinkAnchor', () => {
  it('extracts preview heading anchor ids from doc link targets', () => {
    expect(getMarkdownDocLinkAnchor('docs/setup-guide#Install steps')).toBe('install-steps')
    expect(getMarkdownDocLinkAnchor('docs/setup-guide#What is new?')).toBe('what-is-new')
    expect(getMarkdownDocLinkAnchor('docs/setup-guide#install-steps')).toBe('install-steps')
    expect(getMarkdownDocLinkAnchor('docs/setup-guide')).toBeNull()
  })
})

describe('remarkMarkdownDocLinks', () => {
  it('renders aliased doc links with the alias text', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Markdown,
        { remarkPlugins: [remarkMarkdownDocLinks] },
        'link to [[other.md|Other note]]'
      )
    )

    expect(html).toContain('<a href="#orca-doc-link=other.md">Other note</a>')
    expect(html).not.toContain('[[other.md|Other note]]')
  })

  it('transforms text nodes but not code, links, or images', () => {
    const tree: TestNode = {
      type: 'root',
      children: [
        { type: 'text', value: 'See [[setup-guide]]' },
        { type: 'inlineCode', value: '[[code]]' },
        { type: 'link', url: '[[url]]', children: [{ type: 'text', value: '[[label]]' }] },
        { type: 'image', url: '[[image]]' }
      ]
    }

    remarkMarkdownDocLinks()(tree)

    expect(tree.children?.[0]).toMatchObject({
      type: 'text',
      value: 'See '
    })
    expect(tree.children?.[1]).toMatchObject({
      type: 'link',
      url: '#orca-doc-link=setup-guide'
    })
    expect(tree.children?.[2]).toEqual({ type: 'inlineCode', value: '[[code]]' })
    expect(tree.children?.[3]).toEqual({
      type: 'link',
      url: '[[url]]',
      children: [{ type: 'text', value: '[[label]]' }]
    })
    expect(tree.children?.[4]).toEqual({ type: 'image', url: '[[image]]' })
  })
})
