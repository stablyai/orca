import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../plugin-declarative-catalog'
import { listElements } from './testing-tree'

describe('listElements roles', () => {
  it('gives CodeInput the combobox role it renders with, and keeps text fields as textboxes', () => {
    const tree: PluginDeclarativeNode = {
      type: 'Stack',
      props: {},
      children: [
        { type: 'Input', key: 'name', props: { label: 'Name' }, children: [] },
        { type: 'Textarea', key: 'notes', props: { label: 'Notes' }, children: [] },
        { type: 'CodeInput', key: 'filter', props: { label: 'Filter' }, children: [] }
      ]
    }
    const roles = Object.fromEntries(
      listElements(tree)
        .filter((element) => element.key)
        .map((element) => [element.key, element.role])
    )
    expect(roles).toEqual({ name: 'textbox', notes: 'textbox', filter: 'combobox' })
  })
})
