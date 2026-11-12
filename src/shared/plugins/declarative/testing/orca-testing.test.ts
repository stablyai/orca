import { afterEach, describe, expect, it } from 'vitest'
import { atom, read, set, update } from '../runtime/declarative-atoms'
import { h } from '../runtime/declarative-elements'

import { mount, stored, type TestPanel } from './orca-testing'

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
})

const count = atom('testing.count', 0, { persist: 'plugin' })
const draft = atom('')
const done = atom(false)

function Counter() {
  return h(
    'Stack',
    null,
    h('Heading', null, `Count ${read(count)}`),
    h('Button', { key: 'add', onPress: () => update(count, (n) => n + 1) }, 'Add'),
    h('Input', {
      label: 'Title',
      value: read(draft),
      onChange: (value: string) => set(draft, value),
      onSubmit: () => set(draft, '')
    }),
    h('Switch', {
      label: 'Done',
      checked: read(done),
      onChange: (value: boolean) => set(done, value)
    }),
    h('Select', {
      label: 'Size',
      defaultValue: 's',
      options: [
        { value: 's', label: 'Small' },
        { value: 'l', label: 'Large' },
        { value: 'x', label: 'Huge', disabled: true }
      ],
      onChange: () => undefined
    })
  )
}

describe('orca/testing', () => {
  it('starts each mount fresh and hydrates persisted values, migrating old versions', async () => {
    panel = await mount(Counter, { persisted: { plugin: { 'testing.count': 41 } } })
    expect(panel.find({ role: 'heading' })?.text).toBe('Count 41')
    await panel.unmount()
    panel = await mount(Counter)
    expect(panel.find({ role: 'heading' })?.text).toBe('Count 0')
    const legacy = atom('testing.legacy', 'new', {
      persist: 'plugin',
      version: 2,
      migrate: (old) => `migrated ${String(old)}`
    })
    await panel.unmount()
    panel = await mount(() => h('Text', null, read(legacy)), {
      persisted: { plugin: { 'testing.legacy': stored('v1', 1) } }
    })
    expect(panel.tree()).toEqual({ type: 'Text', children: ['migrated v1'] })
  })

  it("reports a render Orca would refuse and the plugin's own errors", async () => {
    panel = await mount(() => h('List', null, h('Text', null, 'not an item')))
    expect(panel.errors).toEqual([
      expect.objectContaining({ kind: 'refused', message: expect.stringContaining('ListItem') })
    ])
    await panel.unmount()
    panel = await mount(() =>
      h(
        'Button',
        {
          onPress: () => {
            throw new Error('boom')
          }
        },
        'x'
      )
    )
    await panel.press({ role: 'button' })
    expect(panel.errors).toEqual([
      { kind: 'plugin', message: 'boom', stack: expect.stringContaining('orca-testing.test.ts') }
    ])
    await panel.unmount()
    panel = await mount(() => h('Text', { color: 'red' }, 'x'))
    expect(panel.warnings).toEqual(['Text: ignored unknown prop "color"'])
  })

  it('fails a test that never settles instead of hanging', async () => {
    const ticks = atom(0)
    const loop = () => {
      queueMicrotask(() => update(ticks, (n) => n + 1))
      return h('Text', null, String(read(ticks)))
    }
    await expect(mount(loop)).rejects.toThrow(/did not settle/)
  })
})
