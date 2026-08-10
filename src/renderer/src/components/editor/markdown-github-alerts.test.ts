import { describe, expect, it } from 'vitest'
import { remarkGithubAlerts } from './markdown-github-alerts'

type Node = {
  type: string
  value?: string
  children?: Node[]
  data?: { hProperties?: Record<string, unknown> }
}

function blockquote(...lines: string[]): Node {
  // One paragraph whose text is the joined lines (soft breaks = one text node),
  // mirroring the mdast shape before remark-breaks runs.
  return {
    type: 'blockquote',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: lines.join('\n') }] }]
  }
}

function run(node: Node): Node {
  remarkGithubAlerts()({ type: 'root', children: [node] })
  return node
}

function className(node: Node): unknown {
  return node.data?.hProperties?.className
}

describe('remarkGithubAlerts', () => {
  it('tags a valid alert and strips the marker', () => {
    const node = run(blockquote('[!NOTE]', 'Body text.'))
    expect(className(node)).toEqual(['markdown-alert', 'markdown-alert-note'])
    const text = node.children![0].children![0]
    expect(text.value).toBe('Body text.')
  })

  it('matches every supported type case-insensitively', () => {
    for (const [marker, cls] of [
      ['[!TIP]', 'markdown-alert-tip'],
      ['[!important]', 'markdown-alert-important'],
      ['[!Warning]', 'markdown-alert-warning'],
      ['[!CAUTION]', 'markdown-alert-caution']
    ] as const) {
      const node = run(blockquote(marker, 'x'))
      expect(className(node)).toEqual(['markdown-alert', cls])
    }
  })

  it('ignores an unknown alert type', () => {
    const node = run(blockquote('[!DANGER]', 'Body.'))
    expect(className(node)).toBeUndefined()
  })

  it('ignores a marker with inline content on the same line', () => {
    const node = run(blockquote('[!TIP] inline text is not an alert'))
    expect(className(node)).toBeUndefined()
  })

  it('drops the empty paragraph when the marker is alone', () => {
    const node = run(blockquote('[!NOTE]'))
    expect(className(node)).toEqual(['markdown-alert', 'markdown-alert-note'])
    expect(node.children).toHaveLength(0)
  })
})
