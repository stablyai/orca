import { describe, expect, it } from 'vitest'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})
const parse = (raw: unknown) => parsePluginDeclarativeTree(raw)
const columns = [{ key: 'name', label: 'Name', sortable: true }]

describe('catalog 2 components', () => {
  it('draws a placeholder for a Table or Tree with unusable data, and keeps the rest', () => {
    const duplicateRows = node('Table', {
      label: 'T',
      columns,
      rows: [
        { key: 'r', cells: {} },
        { key: 'r', cells: {} }
      ]
    })
    type Item = { key: string; label: string; children: Item[] }
    const tooDeep: Item = { key: 'x0', label: 'x', children: [] }
    let cursor = tooDeep
    for (let depth = 1; depth <= LIMITS.maxTreeItemDepth; depth++) {
      const next: Item = { key: `x${depth}`, label: 'x', children: [] }
      cursor.children.push(next)
      cursor = next
    }
    const deepTree = node('Tree', { label: 'T', items: [tooDeep] })
    const result = parse(node('Stack', {}, [duplicateRows, deepTree, node('Text', {}, ['kept'])]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tree?.children.map((child) => typeof child !== 'string' && child.type)).toEqual(
        ['Unsupported', 'Unsupported', 'Text']
      )
    }
  })
})
