import { expect, it } from 'vitest'
import {
  extractFrontMatter,
  markdownFrontMatterInner,
  prependFrontMatter
} from './markdown-frontmatter'

it('keeps a UTF-8 BOM and CRLF front matter intact when the document body is edited', () => {
  const raw = '\uFEFF---\r\ntitle: Report\r\n---\r\n'
  const frontMatter = extractFrontMatter(`${raw}# Draft\r\n`)

  expect(frontMatter).toEqual({ raw, body: '# Draft\r\n' })
  expect(markdownFrontMatterInner(frontMatter)).toBe('title: Report')
  expect(prependFrontMatter(raw, '# Final\r\n')).toBe(`${raw}# Final\r\n`)
})
