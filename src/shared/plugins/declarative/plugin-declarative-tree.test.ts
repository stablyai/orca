import { describe, expect, it } from 'vitest'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

describe('parsePluginDeclarativeTree', () => {
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
})

describe('ui.* payloads', () => {
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
