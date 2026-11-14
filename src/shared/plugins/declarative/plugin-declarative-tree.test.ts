import { describe, expect, it } from 'vitest'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

describe('parsePluginDeclarativeTree', () => {
  it('drops unknown props and enum values instead of refusing', () => {
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
