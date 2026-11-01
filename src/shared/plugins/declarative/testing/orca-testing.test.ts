import { afterEach, describe, expect, it } from 'vitest'
import { atom, read, set, update } from '../runtime/declarative-atoms'
import { h } from '../runtime/declarative-elements'
import { host, on, shell } from '../runtime/orca-module'
import { hostError, mockHost, mount, stored, type TestPanel } from './orca-testing'

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
  it('mounts a panel, finds by text, role, label and testId, and presses', async () => {
    panel = await mount(Counter)
    expect(panel.find({ role: 'heading' })?.text).toBe('Count 0')
    expect(panel.find({ testId: 'add' })?.type).toBe('Button')
    expect(panel.findAll({ role: 'button' })).toHaveLength(1)
    await panel.press({ text: 'Add' })
    await panel.press({ text: 'Add' })
    expect(panel.find({ text: /Count 2/ })).not.toBeNull()
    expect(panel.persisted.plugin).toEqual({ 'testing.count': 2 })
  })

  it('types, submits, toggles and selects like Orca does', async () => {
    panel = await mount(Counter)
    const title = panel.find({ label: 'Title' })!
    await panel.type(title, 'hi')
    expect(panel.valueOf(title)).toBe('hi')
    expect(read(draft)).toBe('hi')
    await panel.submit(title)
    expect(panel.valueOf(title)).toBe('')
    await panel.toggle({ label: 'Done' })
    expect(read(done)).toBe(true)
    await panel.select({ label: 'Size' }, 'l')
    expect(panel.valueOf({ label: 'Size' })).toBe('l')
    await expect(panel.select({ label: 'Size' }, 'x')).rejects.toThrow(/no enabled option "x"/)
    await expect(panel.press({ text: 'Nope' })).rejects.toThrow(/nothing in the panel matches/)
  })

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

  it('enforces capabilities and the press-grants-one-gesture rule', async () => {
    const fake = mockHost({
      capabilities: ['notifications:show'],
      results: {
        'workspace.readContext': () => {
          throw hostError('unavailable', 'no workspace')
        }
      }
    })
    const outcomes: string[] = []
    const record = (promise: Promise<unknown>) =>
      promise.then(
        () => outcomes.push('ok'),
        (error: { code: string }) => outcomes.push(error.code)
      )
    panel = await mount(
      () =>
        h(
          'Stack',
          null,
          h('Button', { onPress: () => record(shell.openExternal('https://example.com')) }, 'Open'),
          h(
            'Button',
            { onPress: () => record(host.call('notifications.show', { title: 'hi' })) },
            'Notify'
          )
        ),
      { host: fake }
    )
    await record(shell.openExternal('https://example.com'))
    await panel.press({ text: 'Open' })
    await record(host.call('workspace.readContext'))
    await panel.press({ text: 'Notify' })
    expect(outcomes).toEqual(['not_permitted', 'ok', 'capability_denied', 'ok'])
    expect(fake.callsOf('shell.openExternal')).toEqual([
      { url: 'https://example.com' },
      { url: 'https://example.com' }
    ])
  })

  it('delivers events and visibility, and runs setup cleanup on unmount', async () => {
    const seen: string[] = []
    let cleaned = false
    panel = await mount({
      setup: (ctx: {
        subscriptions: { dispose(): void }[]
        visible: Parameters<typeof read<boolean>>[0]
      }) => {
        ctx.subscriptions.push(on('theme', (payload) => seen.push(JSON.stringify(payload))))
        return () => {
          cleaned = true
        }
      },
      default: () => h('Text', null, 'x')
    })
    await panel.emit('theme', { colorScheme: 'light' })
    expect(seen).toEqual(['{"colorScheme":"light"}'])
    await panel.unmount()
    panel = null
    expect(cleaned).toBe(true)
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
