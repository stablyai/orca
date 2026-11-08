import { describe, expect, it } from 'vitest'

import { createMarkdownDocumentIndex, resolveMarkdownDocLink } from './markdown-doc-links'

describe('resolveMarkdownDocLink', () => {
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
})
