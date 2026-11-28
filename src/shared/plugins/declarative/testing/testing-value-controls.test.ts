import { describe, expect, it } from 'vitest'
import type { PluginDeclarativeNode } from '../plugin-declarative-catalog'
import { listElements } from './testing-tree'
import { createValueControls } from './testing-value-controls'

function textControl(
  type: 'CodeInput' | 'Input' | 'Textarea',
  defaultValue: string,
  extra: Record<string, unknown> = {}
) {
  const tree: PluginDeclarativeNode = {
    type: 'Stack',
    props: {},
    children: [
      { type, key: 'field', props: { label: 'Field', defaultValue, ...extra }, children: [] }
    ]
  }
  const element = listElements(tree).find((entry) => entry.key === 'field')
  if (!element) {
    throw new Error('no field')
  }
  return element
}

const codeInput = (defaultValue: string, extra: Record<string, unknown> = {}) =>
  textControl('CodeInput', defaultValue, extra)

describe('typeInto', () => {
  it('types onto a CodeInput seed with its line breaks as LF, as the panel renders it', () => {
    const edits = createValueControls().typeInto(codeInput('a\r\nb\rc'), 'd', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a\nb\ncd'])
  })

  it('types CRLF and CR line breaks into a CodeInput as LF', () => {
    const edits = createValueControls().typeInto(codeInput(''), 'a\r\nb\rc', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a', 'a\n', 'a\nb', 'a\nb\n', 'a\nb\nc'])
  })

  it('stores a CodeInput seed as LF when no characters are typed', () => {
    const edits = createValueControls().typeInto(codeInput('a\r\nb\rc'), '', false)
    expect(edits.map((edit) => edit.value)).toEqual(['a\nb\nc'])
  })

  it('emits no edit for an empty type onto an LF CodeInput seed', () => {
    expect(createValueControls().typeInto(codeInput('a\nb'), '', false)).toEqual([])
  })

  it('types CRLF and CR line breaks into an Input or Textarea unchanged', () => {
    for (const type of ['Input', 'Textarea'] as const) {
      const edits = createValueControls().typeInto(textControl(type, ''), 'a\r\nb', false)
      expect(edits.at(-1)?.value).toBe('a\r\nb')
    }
  })

  it('stops typing at maxLength, as the rendered field drops the keystroke', () => {
    for (const type of ['CodeInput', 'Input', 'Textarea'] as const) {
      const edits = createValueControls().typeInto(
        textControl(type, 'to', { maxLength: 3 }),
        'tal',
        false
      )
      expect(edits.map((edit) => edit.value)).toEqual(['tot'])
    }
  })

  it('skips a surrogate pair that does not fit in maxLength', () => {
    const edits = createValueControls().typeInto(
      codeInput('ab', { maxLength: 3 }),
      '\u{1F600}c',
      false
    )
    expect(edits.map((edit) => edit.value)).toEqual(['abc'])
  })
})

describe('edit ids', () => {
  it("start past the control's $edit acknowledgement, as the panel's do", () => {
    const element = codeInput('', { value: 'seen', onChange: 'cb', $edit: 4 })
    const edits = createValueControls().typeInto(element, 'x', false)
    expect(edits).toEqual([{ value: 'seenx', id: 5 }])
  })
})
