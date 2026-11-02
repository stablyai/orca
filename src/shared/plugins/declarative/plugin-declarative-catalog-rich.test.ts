import { describe, expect, it } from 'vitest'
import {
  isPluginDeclarativeComponentName,
  PLUGIN_DECLARATIVE_CATALOG
} from './plugin-declarative-catalog'
import { isPluginDeclarativeImagePath } from './plugin-declarative-content-props'
import {
  PLUGIN_DECLARATIVE_EDIT_PROP,
  PLUGIN_DECLARATIVE_VALUE_CONTROLS
} from './plugin-declarative-message-names'
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
  it('gives every value control its value prop, change callback and edit tag', () => {
    for (const [type, { value, change }] of Object.entries(PLUGIN_DECLARATIVE_VALUE_CONTROLS)) {
      expect(isPluginDeclarativeComponentName(type)).toBe(true)
      const shape: Record<string, unknown> = isPluginDeclarativeComponentName(type)
        ? PLUGIN_DECLARATIVE_CATALOG[type].props.shape
        : {}
      expect({
        type,
        props: [value, change, PLUGIN_DECLARATIVE_EDIT_PROP].filter((p) => p in shape)
      }).toEqual({ type, props: [value, change, PLUGIN_DECLARATIVE_EDIT_PROP] })
    }
  })

  it('accepts every new component in its place', () => {
    const result = parse(
      node('Stack', {}, [
        node('Field', { label: 'Notes', error: 'Required' }, [
          node('Textarea', { label: 'Notes', rows: 3 })
        ]),
        node('Checkbox', { label: 'Agree', defaultChecked: true }),
        node('RadioGroup', { label: 'Size', options: [{ value: 's', label: 'Small' }] }),
        node('Slider', { label: 'Volume', min: 0, max: 10, step: 0.5 }),
        node('Tabs', { label: 'Views', defaultValue: 'a' }, [
          node('Tab', { value: 'a', label: 'A' }, [node('Text', {}, ['first'])]),
          node('Tab', { value: 'b', label: 'B' })
        ]),
        node('Collapsible', { title: 'More' }, [node('Text', {}, ['hidden'])]),
        node('Toolbar', { label: 'Actions' }, [node('Button', { tooltip: 'Run it' }, ['Run'])]),
        node('Grid', { columns: 3 }, [node('Card', { title: 'One' })]),
        node('Table', { label: 'Files', columns, rows: [{ key: 'r1', cells: { name: 'a.ts' } }] }),
        node('Tree', {
          label: 'Folders',
          items: [{ key: 'src', label: 'src', children: [{ key: 'src/a', label: 'a' }] }]
        }),
        node('Markdown', { content: '# Hi\n\n[docs](https://example.com)' }),
        node('CodeView', { code: 'let a = 1', language: 'typescript', lineNumbers: true }),
        node('Image', { src: 'assets/logo.png', alt: 'Logo' }),
        node('KeyValue', { items: [{ label: 'Branch', value: 'main', code: true }] }),
        node('Callout', { tone: 'warning', title: 'Heads up' }, ['Careful']),
        node('Skeleton', { lines: 2 })
      ])
    )
    expect(result).toMatchObject({ ok: true, warnings: [] })
  })

  it('keeps Tab inside Tabs and Tabs holding only Tab', () => {
    expect(parse(node('Stack', {}, [node('Tab', { value: 'a', label: 'A' })]))).toMatchObject({
      ok: false,
      error: expect.stringContaining('Tab must be a direct child of Tabs')
    })
    expect(parse(node('Tabs', { label: 'T' }, [node('Text', {}, ['loose'])]))).toMatchObject({
      ok: false,
      error: expect.stringContaining('Tabs holds only Tab')
    })
    expect(parse(node('Tabs', { label: 'T' }, ['text']))).toMatchObject({ ok: false })
    expect(parse(node('List', {}, [node('Tab', { value: 'a', label: 'A' })]))).toMatchObject({
      ok: false
    })
  })

  it('keeps new controls out of a pressable ListItem', () => {
    const result = parse(
      node('List', {}, [
        node('ListItem', { onPress: { $callback: 'c1' } }, [node('Checkbox', { label: 'x' })])
      ])
    )
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Checkbox') })
  })

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
      expect(result.warnings).toEqual(
        expect.arrayContaining(['Table: ignored invalid rows', 'Tree: ignored invalid items'])
      )
    }
  })

  it('returns Tree items as a fresh copy holding only known fields', () => {
    const result = parse(
      node('Tree', {
        label: 'T',
        items: [{ key: 'a', label: 'A', hasChildren: true, children: [{ key: 'b', label: 'B' }] }]
      })
    )
    expect(result.ok && result.tree?.props).toEqual({
      label: 'T',
      items: [{ key: 'a', label: 'A', hasChildren: true, children: [{ key: 'b', label: 'B' }] }]
    })
    const extra = parse(
      node('Tree', { label: 'T', items: [{ key: 'a', label: 'A', html: '<b>' }] })
    )
    expect(extra.ok && extra.tree?.type).toBe('Unsupported')
  })

  it('takes only image files inside the plugin', () => {
    for (const path of ['logo.png', 'assets/icons/a.WEBP', 'img/photo.jpeg']) {
      expect({ path, ok: isPluginDeclarativeImagePath(path) }).toEqual({ path, ok: true })
    }
    for (const path of [
      'https://example.com/a.png',
      'data:image/png;base64,AAAA.png',
      '/etc/a.png',
      '../a.png',
      'assets/../../a.png',
      './a.png',
      'a\\b.png',
      'a.png?x=1.png',
      'notes.txt',
      'logo.svg',
      'anim.gif',
      'assets//a.png'
    ]) {
      expect({ path, ok: isPluginDeclarativeImagePath(path) }).toEqual({ path, ok: false })
    }
  })
})
