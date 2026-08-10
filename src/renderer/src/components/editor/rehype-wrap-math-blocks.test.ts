import { describe, expect, it } from 'vitest'
import { rehypeWrapMathBlocks } from './rehype-wrap-math-blocks'

type El = {
  type: string
  tagName?: string
  properties?: { className?: string[] }
  position?: unknown
  children?: El[]
}

function pre(codeClass: string[], position?: unknown): El {
  return {
    type: 'element',
    tagName: 'pre',
    position,
    children: [
      { type: 'element', tagName: 'code', properties: { className: codeClass }, children: [] }
    ]
  }
}

function root(...children: El[]): El {
  return { type: 'root', children }
}

function run(tree: El): El {
  rehypeWrapMathBlocks()(tree)
  return tree
}

describe('rehypeWrapMathBlocks', () => {
  it('wraps a language-math pre in a positioned math-block div', () => {
    const position = { start: { line: 3 }, end: { line: 5 } }
    const tree = run(root(pre(['hljs', 'language-math'], position)))
    const div = tree.children![0]
    expect(div.tagName).toBe('div')
    expect(div.properties?.className).toEqual(['math-block'])
    // Position must survive so the annotation layer can anchor a note.
    expect(div.position).toBe(position)
    expect(div.children![0].tagName).toBe('pre')
  })

  it('also wraps a math-display pre', () => {
    const tree = run(root(pre(['language-math', 'math-display'])))
    expect(tree.children![0].properties?.className).toEqual(['math-block'])
  })

  it('leaves non-math code fences untouched', () => {
    const tree = run(root(pre(['hljs', 'language-js'])))
    expect(tree.children![0].tagName).toBe('pre')
  })

  it('wraps math nested inside a blockquote', () => {
    const blockquote: El = {
      type: 'element',
      tagName: 'blockquote',
      children: [pre(['language-math'])]
    }
    run(root(blockquote))
    expect(blockquote.children![0].tagName).toBe('div')
    expect(blockquote.children![0].properties?.className).toEqual(['math-block'])
  })

  it('does not double-wrap on a repeated pass', () => {
    const tree = run(root(pre(['language-math'])))
    const wrapper = tree.children![0]
    run(tree)
    expect(tree.children).toHaveLength(1)
    expect(tree.children![0]).toBe(wrapper)
    // The inner pre was not wrapped a second time.
    expect(wrapper.children![0].tagName).toBe('pre')
  })
})
