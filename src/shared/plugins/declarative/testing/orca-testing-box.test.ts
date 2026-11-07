import { afterEach, describe, expect, it } from 'vitest'
import { h } from '../runtime/declarative-elements'
import { mount, type TestPanel } from './orca-testing'

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
})

function Status() {
  return h(
    'Box',
    { key: 'page', gap: 'md' },
    h(
      'Box',
      { key: 'header', direction: 'row', justify: 'between', background: 'muted' },
      h('Heading', null, 'Services'),
      h('Button', { onPress: () => undefined }, 'Refresh')
    ),
    h(
      'Box',
      { key: 'billing', border: 'danger', padding: 'sm' },
      h('Text', null, 'billing'),
      h('Badge', { tone: 'danger' }, 'Down')
    )
  )
}

describe('orca/testing reads Box', () => {
  it('finds Boxes by type, role, text and testId, and controls inside them', async () => {
    panel = await mount({ default: Status })
    // Innermost matches only: the page Box holds the other two.
    expect(panel.findAll({ type: 'Box' }).map((box) => box.key)).toEqual(['header', 'billing'])
    expect(panel.find({ testId: 'page' })?.text).toBe('Services Refresh billing Down')
    expect(panel.find({ testId: 'billing' })).toMatchObject({
      type: 'Box',
      role: 'group',
      text: 'billing Down',
      props: { border: 'danger', padding: 'sm' }
    })
    // The innermost match wins: the button, not the Boxes around it.
    expect(panel.find({ text: 'Refresh' })?.type).toBe('Button')
    expect(panel.find({ role: 'button', text: 'Refresh' })?.path).toBe('page/header/#1')
    expect(panel.errors).toEqual([])
    expect(panel.warnings).toEqual([])
  })

  it('summarizes what sits in Boxes, and danger or warning Boxes themselves', async () => {
    panel = await mount({ default: Status })
    expect(panel.summary()).toEqual(['Heading "Services"', 'Box danger "billing Down"'])
  })

  it('reports invalid Box props as warnings', async () => {
    panel = await mount({
      default: () => h('Box', { background: '#ff0000', width: '50px' }, 'x')
    })
    expect(panel.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Box: ignored invalid background'),
        expect.stringContaining('Box: ignored invalid width')
      ])
    )
  })
})
