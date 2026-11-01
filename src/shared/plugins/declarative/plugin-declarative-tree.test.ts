import { describe, expect, it } from 'vitest'
import {
  PLUGIN_DECLARATIVE_CATALOG,
  PLUGIN_DECLARATIVE_COMPONENT_NAMES
} from './plugin-declarative-catalog'
import { PLUGIN_DECLARATIVE_LIMITS } from './plugin-declarative-limits'
import {
  PLUGIN_DECLARATIVE_COMPONENT_PROPS,
  PLUGIN_DECLARATIVE_EDIT_PROP
} from './plugin-declarative-message-names'
import {
  parsePluginDeclarativeRender,
  pluginDeclarativeEventPayloadSchema
} from './plugin-declarative-messages'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function errorOf(tree: unknown): string {
  const result = parsePluginDeclarativeTree(tree)
  return result.ok ? '' : result.error
}

describe('parsePluginDeclarativeTree', () => {
  it('keeps the zod catalog and the runtime prop table in step', () => {
    expect([...PLUGIN_DECLARATIVE_COMPONENT_NAMES].sort()).toEqual(
      Object.keys(PLUGIN_DECLARATIVE_COMPONENT_PROPS).sort()
    )
    for (const name of PLUGIN_DECLARATIVE_COMPONENT_NAMES) {
      const zodProps = Object.keys(PLUGIN_DECLARATIVE_CATALOG[name].props.shape).filter(
        (prop) => prop !== PLUGIN_DECLARATIVE_EDIT_PROP
      )
      const runtimeProps: readonly string[] = PLUGIN_DECLARATIVE_COMPONENT_PROPS[name]
      expect({ name, props: [...runtimeProps].sort() }).toEqual({ name, props: zodProps.sort() })
    }
  })

  it('accepts a valid tree, normalizes numbers and drops nothing it knows', () => {
    const code = node('Code', {}, ['x'])
    const text = node('Text', { tone: 'accent', muted: true }, ['Count ', 4, code])
    const rest = [
      node('Button', { onPress: { $callback: 'c1' }, icon: 'add', tone: 'danger' }, ['Add']),
      node('List', { label: 'Items' }, [{ ...node('ListItem', { title: 'A' }), key: 'a' }]),
      node('Select', {
        label: 'Pick',
        options: [{ value: 'a', label: 'A' }],
        onChange: { $callback: 'c2' }
      }),
      node('Link', { href: 'https://example.com' }, ['docs'])
    ]
    const tree = node('Stack', { gap: 'sm' }, [text, ...rest])
    const result = parsePluginDeclarativeTree(tree)
    expect(result).toMatchObject({ ok: true, nodes: 8, warnings: [] })
    expect(result.ok && result.tree).toEqual({
      ...tree,
      children: [{ ...text, children: ['Count ', '4', code] }, ...rest]
    })
    expect(parsePluginDeclarativeTree(null)).toEqual({
      ok: true,
      tree: null,
      nodes: 0,
      warnings: []
    })
  })

  it('drops unknown props and enum values with a warning instead of refusing', () => {
    const result = parsePluginDeclarativeTree(
      node('Stack', { className: 'p-4', gap: 'huge' }, [
        node('Text', { tone: '#ff0000' }, ['x']),
        node('IconButton', { icon: 'skull', label: 'Odd' })
      ])
    )
    expect(result.ok && result.tree).toMatchObject({
      props: {},
      children: [
        { type: 'Text', props: {} },
        { type: 'IconButton', props: { icon: 'skull' } }
      ]
    })
    expect(result.ok && result.warnings).toEqual([
      'Stack: ignored unknown prop "className"',
      'Stack: ignored invalid gap',
      'Text: ignored invalid tone',
      'IconButton: unknown icon "skull"; showing a fallback glyph'
    ])
  })

  it('draws unknown components, and known ones missing a required prop, as placeholders', () => {
    const result = parsePluginDeclarativeTree(
      node('Stack', {}, [
        { ...node('Carousel', { slides: 3 }, [node('Text')]), key: 'c' },
        node('Input', { placeholder: 'No label' })
      ])
    )
    expect(result.ok && result.tree?.children).toEqual([
      { type: 'Unsupported', key: 'c', props: { name: 'Carousel' }, children: [] },
      { type: 'Unsupported', props: { name: 'Input' }, children: [] }
    ])
  })

  it.each([
    ['a DOM tag', node('div'), /invalid component name/],
    ['a prototype-named component', node('constructor'), /invalid component name/],
    ['an unknown node field', { ...node('Stack'), style: {} }, /unknown node field/],
    ['text in a leaf', node('Separator', {}, ['x']), /does not accept text/],
    ['a block inside Text', node('Text', {}, [node('Stack')]), /accepts only text, Text/],
    ['a node inside Button', node('Button', {}, [node('Text')]), /accepts only text/],
    ['a stray ListItem', node('Stack', {}, [node('ListItem')]), /ListItem/],
    ['a non-item in List', node('List', {}, [node('Text')]), /ListItem/],
    [
      'duplicate sibling keys',
      node('Stack', {}, [
        { ...node('Text'), key: 'k' },
        { ...node('Text'), key: 'k' }
      ]),
      /duplicate key "k"/
    ],
    [
      'a control inside a pressable ListItem',
      node('List', {}, [
        node('ListItem', { onPress: { $callback: 'c1' } }, [
          node('Button', { onPress: { $callback: 'c2' } }, ['x'])
        ])
      ]),
      /cannot contain a Button/
    ],
    ['a text root', 'hello', /root/],
    ['a non-finite number', node('Text', {}, [Number.NaN]), /finite/]
  ])('rejects %s', (_label, tree, message) => {
    expect(errorOf(tree)).toMatch(message)
  })

  it('allows controls inside a ListItem that has no onPress', () => {
    const tree = node('List', {}, [node('ListItem', {}, [node('Button', {}, ['x'])])])
    expect(parsePluginDeclarativeTree(tree).ok).toBe(true)
  })

  it('caps depth without recursing', () => {
    let tree = node('Text')
    for (let depth = 0; depth < 10_000; depth++) {
      tree = node('Stack', {}, [tree])
    }
    expect(errorOf(tree)).toMatch(/deeper than 64/)
  })

  it('caps node count and total bytes', () => {
    const many = node(
      'Stack',
      {},
      Array.from({ length: PLUGIN_DECLARATIVE_LIMITS.maxNodes }, () =>
        node('Spinner', { label: 'x' })
      )
    )
    expect(errorOf(many)).toMatch(/more than 5000 nodes/)
    const text = 'x'.repeat(PLUGIN_DECLARATIVE_LIMITS.maxTextLength)
    const heavy = node(
      'Stack',
      {},
      Array.from({ length: 40 }, () => node('Text', {}, [text]))
    )
    expect(errorOf(heavy)).toMatch(/exceeds/)
  })
})

describe('ui.* payloads', () => {
  it('validates render payloads through the tree parser, keeping the revision', () => {
    expect(
      parsePluginDeclarativeRender({
        document: 'd1',
        revision: 3,
        tree: node('Spinner', { label: 'x' })
      })
    ).toMatchObject({ ok: true, document: 'd1', revision: 3 })
    expect(
      parsePluginDeclarativeRender({ document: 'd1', revision: 3, tree: node('marquee') })
    ).toMatchObject({ ok: false, document: 'd1', revision: 3 })
    expect(parsePluginDeclarativeRender({ revision: 1, tree: null })).toMatchObject({
      ok: false,
      revision: null
    })
  })

  it('accepts plain JSON event args: scalars, scalar lists and one flat object', () => {
    const base = { document: 'd1', revision: 1, callback: '1.0' }
    const accepts = (args: unknown[]): boolean =>
      pluginDeclarativeEventPayloadSchema.safeParse({ ...base, args }).success
    expect(accepts(['a', 1, true, null])).toBe(true)
    expect(accepts([['a', 'b'], { keys: ['a'] }, { column: 'name', direction: 'asc' }])).toBe(true)
    expect(accepts([{ nested: { deeper: 1 } }])).toBe(false)
    expect(accepts([[['nested']]])).toBe(false)
    expect(accepts([Number.NaN])).toBe(false)
    expect(
      pluginDeclarativeEventPayloadSchema.safeParse({ ...base, args: [], extra: 1 }).success
    ).toBe(false)
  })

  it('counts text children toward the node cap and charges each one', () => {
    const many = (count: number) => ({
      type: 'Text',
      props: {},
      children: Array.from({ length: count }, () => '')
    })
    expect(parsePluginDeclarativeTree(many(4000)).ok).toBe(true)
    const flood = parsePluginDeclarativeTree({
      type: 'Stack',
      props: {},
      children: [many(4000), many(4000)]
    })
    expect(flood).toMatchObject({ ok: false, error: expect.stringContaining('nodes') })
  })
})
