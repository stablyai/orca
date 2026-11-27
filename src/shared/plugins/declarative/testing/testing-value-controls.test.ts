import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../plugin-declarative-catalog'
import { listElements } from './testing-tree'
import { createValueControls } from './testing-value-controls'

function textControl(type: 'CodeInput' | 'Input' | 'Textarea', defaultValue: string) {
  const tree: PluginDeclarativeNode = {
    type: 'Stack',
    props: {},
    children: [{ type, key: 'field', props: { label: 'Field', defaultValue }, children: [] }]
  }
  const element = listElements(tree).find((entry) => entry.key === 'field')
  if (!element) {
    throw new Error('no field')
  }
  return element
}

const codeInput = (defaultValue: string) => textControl('CodeInput', defaultValue)

describe('typeInto', () => {
  it('types onto a CodeInput seed with its line breaks as LF, as the panel renders it', () => {
    const edits = createValueControls().typeInto(codeInput('a\r\nb\rc'), 'd', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a\nb\ncd'])
  })

  it('types CRLF and CR line breaks into a CodeInput as LF', () => {
    const edits = createValueControls().typeInto(codeInput(''), 'a\r\nb\rc', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a', 'a\n', 'a\nb', 'a\nb\n', 'a\nb\nc'])
  })

  it('types CRLF and CR line breaks into an Input or Textarea unchanged', () => {
    for (const type of ['Input', 'Textarea'] as const) {
      const edits = createValueControls().typeInto(textControl(type, ''), 'a\r\nb', false)
      expect(edits.at(-1)?.value).toBe('a\r\nb')
    }
  })
})
