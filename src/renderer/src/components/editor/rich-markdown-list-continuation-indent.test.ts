import { Editor, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function roundTrip(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function documentContent(source: string): JSONContent[] {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getJSON().content ?? []
  } finally {
    editor.destroy()
  }
}

const SHAPES = [
  ['9. Single digit item and words here\n   and must stay inside item 9.'],
  ['10. Two digit item and words here\n    and must stay inside item 10.'],
  ['- Bullet item\n  continuation line here.'],
  ['10. An item mentioning the 12-step\n     write-up are in the folder.'],
  ['1. First\n   cont one.\n2. Second\n   cont two.'],
  ['9. Nine item\n   cont nine.\n10. Ten item\n    cont ten.'],
  ['1. Outer\n   cont outer.\n   1. Inner\n      cont inner.'],
  ['1. Item with a block\n\n   A second paragraph inside.'],
  ['100. Three digit\n     cont three.']
]

describe('list continuation round trip', () => {
  it.each(SHAPES)('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(SHAPES)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('keeps the continuation inside its item rather than deleting characters', () => {
    const source = '10. An item mentioning the 12-step\n     write-up are in the folder.'
    expect(roundTrip(roundTrip(roundTrip(source)))).toContain('write-up')
  })
})

describe('hard break inside a list item', () => {
  it.each([
    ['1. line1  \n   line2', 3],
    ['10. line1  \n    line2', 4],
    ['100. line1  \n     line2', 5],
    ['- line1  \n  line2', 2]
  ])('gives %j the item content column of %i', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([['1. line1  \n   line2'], ['10. line1  \n    line2'], ['- line1  \n  line2']])(
    'keeps %j stable across three cycles',
    (source) => {
      let current = source
      for (let cycle = 0; cycle < 3; cycle += 1) {
        current = roundTrip(current)
      }
      expect(current).toBe(source)
    }
  )

  it('indents an unindented hard-break continuation to the content column', () => {
    expect(roundTrip('1. line1  \nline2')).toBe('1. line1  \n   line2')
    expect(roundTrip('10. line1  \nline2')).toBe('10. line1  \n    line2')
  })

  it('gives every hard-break line the same column', () => {
    expect(roundTrip('1. line1  \n   line2  \n   line3')).toBe('1. line1  \n   line2  \n   line3')
  })
})

describe('nested ordered list continuation', () => {
  it.each([
    ['1. outer\n   1. nested\n\n   outer continuation'],
    ['10. outer\n    1. nested\n\n    outer continuation'],
    ['1. a\n   1. b\n\n   a cont'],
    ['1. outer\n   1. nested\n      nested continuation'],
    ['1. outer\n   10. nested\n       nested cont'],
    ['1. a\n   1. b\n      1. c\n         c cont'],
    ['10. outer\n    10. nested\n\n    outer continuation']
  ])('keeps the continuation at its own indent in %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([
    ['1. outer\n   1. nested\n\n   outer continuation'],
    ['10. outer\n    1. nested\n\n    outer continuation'],
    ['1. a\n   1. b\n\n   a cont']
  ])('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('keeps an outer continuation in the outer item rather than the nested one', () => {
    const source = '1. outer\n   1. nested\n\n   outer continuation'
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    try {
      const outerList = editor.getJSON().content?.[0] as JSONContent
      const outerItem = outerList.content?.[0]
      expect(outerItem?.content?.map((child: JSONContent) => child.type)).toEqual([
        'paragraph',
        'orderedList',
        'paragraph'
      ])
    } finally {
      editor.destroy()
    }
  })

  it.each([
    [
      '1. outer\n   1. nested\n   outer continuation',
      '1. outer\n   1. nested\n      outer continuation'
    ],
    [
      '10. outer\n    1. nested\n    outer continuation',
      '10. outer\n    1. nested\n       outer continuation'
    ]
  ])('re-indents the lazy continuation in %j to its item content column', (source, expected) => {
    expect(roundTrip(source)).toBe(expected)
    expect(roundTrip(expected)).toBe(expected)
  })
})

describe('block context inside an ordered list', () => {
  it.each([
    ['1. parent\n   ```\n   1. literal\n   ```'],
    ['1. parent\n   ```\n   not a list\n   ```\n2. sibling'],
    ['1. parent\n   ```js\n   const a = 1\n   ```']
  ])('keeps the fenced code in %j literal', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it("reads a fence after a blank line as code at the item's column", () => {
    // Why: the serializer emits a tight item, so the blank separator is dropped
    // while the fence keeps the item's content column.
    expect(roundTrip('1. parent\n\n   ```\n   1. literal\n   ```')).toBe(
      '1. parent\n   ```\n   1. literal\n   ```'
    )
  })

  it('reads a tilde-fenced list marker as code rather than an item', () => {
    // Why: the serializer spells every fence with backticks, so only the content
    // of the block is round-tripped here.
    expect(roundTrip('1. parent\n   ~~~\n   2. literal\n   ~~~')).toBe(
      '1. parent\n   ```\n   2. literal\n   ```'
    )
  })

  it('ends the list at a post-blank line no frame owns', () => {
    expect(roundTrip('1. item\n\n  outside')).toBe('1. item\n\n  outside')
  })

  it.each([['1. item\n\n       code'], ['1. item\n\n       code\n\n   after']])(
    'keeps the indented code in %j a code block',
    (source) => {
      const [list] = documentContent(source)
      const item = (list.content ?? [])[0]

      expect((item.content ?? []).map((child) => child.type)).toContain('codeBlock')
    }
  )

  it.each([['0. zero\n1. one'], ['0. only'], ['0. zero\n1. one\n2. two']])(
    'preserves the start value in %j',
    (source) => {
      expect(roundTrip(source)).toBe(source)
    }
  )

  it.each([['0. zero\n1. one'], ['0. only']])('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })
})

describe('interleaved content between nested ordered-list runs', () => {
  function itemChildren(source: string): string[] {
    const [list] = documentContent(source)
    const item = (list.content ?? [])[0]

    return (item.content ?? []).map((child) => child.type ?? '')
  }

  it.each([
    ['1. a\n   1. b\n\n   c\n   1. d', '1. a\n   1. b\n\n   c\n   1. d'],
    ['1. a\n   1. b\n\n   c\n\n   1. d\n   1. e', '1. a\n   1. b\n\n   c\n   1. d\n   2. e'],
    ['10. a\n    1. b\n\n    c\n    1. d', '10. a\n    1. b\n\n    c\n    1. d']
  ])('keeps the block between two nested runs in %j in place', (source, expected) => {
    expect(roundTrip(source)).toBe(expected)
  })

  it.each([
    ['1. a\n   1. b\n\n   c\n   1. d'],
    ['1. a\n   1. b\n\n   c\n\n   1. d\n   1. e'],
    ['10. a\n    1. b\n\n    c\n    1. d']
  ])('gives %j a paragraph between two separate nested lists', (source) => {
    expect(itemChildren(source)).toEqual(['paragraph', 'orderedList', 'paragraph', 'orderedList'])
  })

  it('starts the second nested run at its own number', () => {
    expect(roundTrip('1. a\n   4. b\n\n   c\n   7. d')).toBe('1. a\n   4. b\n\n   c\n   7. d')
  })

  it('keeps a fenced block between two nested runs', () => {
    const source = '1. a\n   1. b\n\n   ```\n   fenced\n   ```\n\n   1. d'

    expect(itemChildren(source)).toEqual(['paragraph', 'orderedList', 'codeBlock', 'orderedList'])
  })

  it('splits three runs of one item at each intervening paragraph', () => {
    const source = '1. a\n   1. b\n\n   c\n   1. d\n\n   e\n   1. f'

    expect(itemChildren(source)).toEqual([
      'paragraph',
      'orderedList',
      'paragraph',
      'orderedList',
      'paragraph',
      'orderedList'
    ])
    expect(roundTrip(source)).toBe(source)
  })

  it('splits the run at the depth the intervening block sits at', () => {
    const source = '1. a\n   1. b\n      1. c\n\n      x\n      1. e'
    const [list] = documentContent(source)
    const outer = (list.content ?? [])[0]
    const nested = (outer.content ?? [])[1]
    const inner = (nested.content ?? [])[0]

    expect((inner.content ?? []).map((child) => child.type)).toEqual([
      'paragraph',
      'orderedList',
      'paragraph',
      'orderedList'
    ])
  })

  it('keeps interleaving independent between sibling items', () => {
    const source = '1. a\n   1. b\n\n   c\n   1. d\n2. e\n   1. f\n\n   g\n   1. h'

    expect(roundTrip(source)).toBe(source)
  })

  it('keeps a blockquote between two nested runs', () => {
    expect(itemChildren('1. a\n   1. b\n\n   > q\n\n   1. d')).toEqual([
      'paragraph',
      'orderedList',
      'blockquote',
      'orderedList'
    ])
  })

  it('keeps a bullet run and a paragraph inside an ordered item in order', () => {
    expect(itemChildren('1. a\n   - b\n\n   c\n   - d')).toEqual([
      'paragraph',
      'bulletList',
      'paragraph',
      'bulletList'
    ])
  })

  it('keeps an ordered run and its following content inside a bullet item in order', () => {
    const children = itemChildren('- a\n  1. b\n\n  c\n  1. d')

    expect(children.filter((type) => type === 'orderedList')).toHaveLength(2)
    expect(children.indexOf('orderedList')).toBeLessThan(children.lastIndexOf('orderedList'))
    expect(children).toHaveLength(4)
  })

  it.each([
    ['1. a\n   1. b\n\n   c\n   1. d'],
    ['1. a\n   1. b\n\n   ```\n   fenced\n   ```\n\n   1. d'],
    ['10. a\n    1. b\n\n    c\n    1. d']
  ])('keeps %j stable across three cycles', (source) => {
    const first = roundTrip(source)
    let current = first
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }

    expect(current).toBe(first)
  })
})

describe('nested ordered-list runs at differing indents', () => {
  function itemChildren(source: string): string[] {
    const [list] = documentContent(source)
    const item = (list.content ?? [])[0]

    return (item.content ?? []).map((child) => child.type ?? '')
  }

  it.each([
    ['1. a\n   1. b\n\n   c\n    1. d'],
    ['1. a\n   1. b\n\n   c\n     1. d'],
    ['1. a\n   1. b\n\n   c\n      1. d'],
    ['10. a\n    1. b\n\n    c\n     1. d'],
    ['1. a\n   1. b\n   > q\n    1. d'],
    ['1. a\n   1. b\n\n   c\n    1. d\n2. e']
  ])('emits the later run of %j instead of consuming it', (source) => {
    expect(roundTrip(source)).toContain('1. d')
  })

  it.each([
    ['1. a\n   1. b\n\n   c\n    1. d'],
    ['1. a\n   1. b\n\n   c\n     1. d'],
    ['1. a\n   1. b\n\n   c\n      1. d'],
    ['10. a\n    1. b\n\n    c\n     1. d']
  ])('gives %j two sibling nested lists around the block', (source) => {
    expect(itemChildren(source)).toEqual(['paragraph', 'orderedList', 'paragraph', 'orderedList'])
  })

  it('keeps a run deeper than the first run out of that run', () => {
    const [list] = documentContent('1. a\n   1. b\n\n   c\n      1. d')
    const item = (list.content ?? [])[0]
    const lists = (item.content ?? []).filter((child) => child.type === 'orderedList')

    expect(lists).toHaveLength(2)
    for (const nested of lists) {
      expect(nested.content ?? []).toHaveLength(1)
    }
  })

  it.each([
    ['1. a\n   1. b\n\n   c\n    1. d'],
    ['1. a\n   1. b\n\n   c\n      1. d'],
    ['1. a\n   1. b\n   > q\n    1. d']
  ])('settles %j into a fixed point after one cycle', (source) => {
    const first = roundTrip(source)
    let current = first
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }

    expect(current).toBe(first)
  })
})

describe('no source line is consumed without being emitted', () => {
  const CORPUS = [
    '1. a\n   1. b\n\n   c\n   1. d',
    '1. a\n   1. b\n\n   c\n    1. d',
    '1. a\n   1. b\n\n   c\n     1. d',
    '1. a\n   1. b\n\n   c\n      1. d',
    '1. a\n   1. b\n   > q\n    1. d',
    '1. a\n   1. b\n\n   c\n    1. d\n2. e',
    '10. a\n    1. b\n\n    c\n     1. d',
    '10. a\n    1. b\n\n    c\n    1. d',
    '1. a\n   1. b\n\n   c\n   1. d\n\n   e\n   1. f',
    '1. a\n   1. b\n      1. c\n\n      x\n      1. e',
    '1. z\n2. a\n   1. b\n\n   c\n   1. d',
    '1. a\n   1. b\n\n   c\n   1. d\n2. e\n   1. f\n\n   g\n   1. h',
    '1. a\n   1. b\n\n   ```\n   fenced\n   ```\n\n   1. d',
    '1. a\n   - b\n\n   c\n    - d',
    '- a\n  1. b\n\n  c\n   1. d'
  ]

  it.each(CORPUS)('keeps every non-blank line of %j in the output', (source) => {
    const output = roundTrip(source)
    const missing = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .filter((line) => !output.includes(line.replace(/^\d+\.\s+/, '').trim()))

    expect(missing).toEqual([])
  })
})
