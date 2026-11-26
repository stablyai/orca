import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../plugin-declarative-catalog'
import { listElements } from './testing-tree'
import { createValueControls } from './testing-value-controls'

function codeInput(defaultValue: string) {
  const tree: PluginDeclarativeNode = {
    type: 'Stack',
    props: {},
    children: [
      { type: 'CodeInput', key: 'field', props: { label: 'Field', defaultValue }, children: [] }
    ]
  }
  const element = listElements(tree).find((entry) => entry.key === 'field')
  if (!element) {
    throw new Error('no field')
  }
  return element
}

describe('typeInto', () => {
  it('types onto a CodeInput seed with its line breaks as LF, as the panel renders it', () => {
    const edits = createValueControls().typeInto(codeInput('a\r\nb\rc'), 'd', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a\nb\ncd'])
  })
})
