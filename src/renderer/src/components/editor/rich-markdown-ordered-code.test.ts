import { describe, expect, it, vi } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import * as facade from './tiptap-marked-facade'

const CODE = 'graph TD\nA[Line1<br/>Line2] --> B'

function fenceItem(marker: string, fence = '```'): string {
  const indent = ' '.repeat(marker.length + 1)
  return `${marker} ${fence}mermaid\n${indent}${CODE.replaceAll('\n', `\n${indent}`)}\n${indent}${fence}\n`
}

describe('ordered-list first-block code admission', () => {
  it.each(['1.', '1)', '10.', '100.', 'a.', 'a)', 'I.', 'iii.'])(
    'keeps first-block fenced code in %s Source-only',
    (marker) => {
      expect(getMarkdownRichModeUnsupportedReason(fenceItem(marker))).toBe('other')
    }
  )

  it.each(['```', '~~~', '````', '~~~~'])(
    'guards %s delimiters without depending on embedded HTML',
    (fence) => {
      expect(
        getMarkdownRichModeUnsupportedReason(fenceItem('1.', fence).replace('<br/>', ''))
      ).toBe('other')
    }
  )

  it('guards a later code-first item', () => {
    expect(getMarkdownRichModeUnsupportedReason(`1. First\n${fenceItem('2.')}`)).toBe('other')
  })

  it('guards a nested code-first item', () => {
    const nested = fenceItem('1.').trimEnd().replaceAll('\n', '\n   ')
    expect(getMarkdownRichModeUnsupportedReason(`1. Parent\n   ${nested}\n`)).toBe('other')
  })

  it('guards an ordered list inside a blockquote', () => {
    expect(
      getMarkdownRichModeUnsupportedReason(
        fenceItem('1.')
          .trimEnd()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
    ).toBe('other')
  })

  it('guards an unclosed first-block code fence', () => {
    expect(getMarkdownRichModeUnsupportedReason('1. ```js\n   const answer = 42\n')).toBe('other')
  })

  it.each([
    '1. ~~~js\n   body\n   ```\n',
    '1. ````js\n   body\n   ```\n',
    '1. ```js\n   body\n   ``` trailing\n',
    '1. ~~~js\n   body\n   ~~~\n'
  ])('keeps invalid/mixed closers in first-block code Source-only: %j', (source) => {
    expect(getMarkdownRichModeUnsupportedReason(source)).toBe('other')
  })

  it.each([
    '- 1. ```js\n     body\n     ```\n',
    '1. 1. ```js\n      body\n      ```\n',
    '> - 1. ```js\n>      body\n>      ```\n',
    '- Parent\n  1. ```js\n     body\n     ```\n',
    '> 1. Parent\n>    1. ```js\n>       body\n>       ```\n',
    '1.\t```js\n\tbody\n\t```\n',
    '1. ```js\r\n   body\r\n   ```\r\n',
    '1. ```js\r   body\r   ```\r',
    '1. prose\n2) ```js\n   body\n   ```\n',
    'a. ```js\n   body\n   ```\n',
    'I. ~~~js\n   body\n   ~~~\n',
    '- a. ```js\n     body\n     ```\n',
    '> I. ~~~js\n>    body\n>    ~~~\n',
    'a. Parent\n   i. ```js\n      body\n      ```\n'
  ])('guards first-block code across containers, whitespace and marker runs: %j', (source) => {
    expect(getMarkdownRichModeUnsupportedReason(source)).toBe('other')
  })

  it('ignores candidates in front matter', () => {
    expect(
      getMarkdownRichModeUnsupportedReason('---\nnote: |\n  1. ```js\n---\nBody.\n')
    ).toBeNull()
  })

  it.each([
    '1. First\n2. Second\n',
    '1. Parent\n   1. Child\n2. Second\n',
    'a. First\nb. Second\n',
    'I. First\nII. Second\n',
    '- ```js\n  const answer = 42\n  ```\n',
    '```js\nconst answer = 42\n```\n',
    '````md\n1. ```js\n   const answer = 42\n   ```\n````\n',
    '````md\na. ```js\n   const answer = 42\n   ```\n````\n',
    '````md\nI. ~~~js\n   const answer = 42\n   ~~~\n````\n',
    'Text 1. ```js is literal.\n',
    '1. ```invalid`info\n   prose\n',
    'a. ```invalid`info\n   prose\n',
    'word. ```js\n   prose\n',
    '1. Intro\n\n   ```js\n   const answer = 42\n   ```\n'
  ])('preserves safe admission for %j', (source) => {
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
  })

  it('does not parse ordinary large documents', () => {
    const create = vi.spyOn(facade, 'createTiptapMarkedFacade')
    try {
      expect(getMarkdownRichModeUnsupportedReason('1. ordinary\n'.repeat(10_000))).toBeNull()
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })

  it.each(['[ref]: /target', '[^note]: text'])(
    'preserves the existing refusal reason for %s before ordered-code checks',
    (refusal) => {
      expect(getMarkdownRichModeUnsupportedReason(`${refusal}\n\n${fenceItem('a.')}`)).toBe(
        getMarkdownRichModeUnsupportedReason(refusal)
      )
    }
  )

  it('rejects whitespace-heavy false candidates before parsing', () => {
    const create = vi.spyOn(facade, 'createTiptapMarkedFacade')
    try {
      expect(
        getMarkdownRichModeUnsupportedReason(`${'> '.repeat(500)}${' '.repeat(10_000)}literal`)
      ).toBeNull()
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })

  it.each(['I.', 'i.', 'a.', 'aa.', '1.'])(
    'rejects repeated %s prefix false candidates before parsing',
    (marker) => {
      const create = vi.spyOn(facade, 'createTiptapMarkedFacade')
      try {
        expect(
          getMarkdownRichModeUnsupportedReason(`${`${marker} `.repeat(1_000)}literal`)
        ).toBeNull()
        expect(create).not.toHaveBeenCalled()
      } finally {
        create.mockRestore()
      }
    }
  )

  it('preserves literal code containing repeated Roman prefix candidates', () => {
    const source = `\`\`\`\`md\n${'I. '.repeat(1_000)}~~~js\nbody\n~~~\n\`\`\`\`\n`
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
  })

  it.each(['1.', 'a.', 'I.'])(
    'keeps oversized %s literal-fence candidates Source-only without structural proof',
    (marker) => {
      const literal = `\`\`\`\`md\n${'x'.repeat(50_001)}\n${fenceItem(marker)}\`\`\`\`\n`
      expect(getMarkdownRichModeUnsupportedReason(literal)).toBe('other')
    }
  )

  it('keeps oversized candidates Source-only without parsing', () => {
    const create = vi.spyOn(facade, 'createTiptapMarkedFacade')
    try {
      expect(
        getMarkdownRichModeUnsupportedReason(`${'x'.repeat(50_001)}\n\n${fenceItem('1.')}`)
      ).toBe('other')
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })

  it('refuses a candidate if structural parsing fails', () => {
    const create = vi.spyOn(facade, 'createTiptapMarkedFacade').mockImplementation(() => {
      throw new Error('parser unavailable')
    })
    try {
      expect(getMarkdownRichModeUnsupportedReason(fenceItem('1.'))).toBe('other')
    } finally {
      create.mockRestore()
    }
  })
})
