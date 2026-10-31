import { describe, expect, it } from 'vitest'
import { withEditorByteSource } from './editor-byte-source'

const target = { kind: 'local' as const }

describe('withEditorByteSource', () => {
  it('keeps bytes editors on an SVG opened as text, but not on other text or granted reads', () => {
    const svg = { filePath: '/repo/logo.svg', relativePath: 'logo.svg', target }
    expect(withEditorByteSource({ content: '<svg/>', isBinary: false }, svg)).toHaveProperty(
      'byteSource',
      svg
    )
    expect(
      withEditorByteSource(
        { content: '# a', isBinary: false },
        { filePath: '/repo/a.md', relativePath: 'a.md', target }
      )
    ).not.toHaveProperty('byteSource')
    expect(
      withEditorByteSource(
        { content: '', isBinary: true },
        { ...svg, terminalArtifactGrantId: 'g' }
      )
    ).not.toHaveProperty('byteSource')
  })
})
