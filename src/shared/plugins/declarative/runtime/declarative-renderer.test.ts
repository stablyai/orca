import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { atom, derived, read, set, update } from './declarative-atoms'
import { Fragment, h, jsx } from './declarative-elements'
import { createOrcaDeclarativeRuntime, type OrcaBridge } from './declarative-renderer'
import { parsePluginDeclarativeTree } from '../plugin-declarative-tree'

type Posted = { event: string; payload: unknown }
type WireNode = {
  type: string
  key: string
  props: Record<string, unknown>
  children: (WireNode | string)[]
}
const wireNodeSchema: z.ZodType<WireNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    key: z.string(),
    props: z.record(z.string(), z.unknown()),
    children: z.array(z.union([z.string(), wireNodeSchema]))
  })
)
const renderSchema = z.object({ document: z.string(), revision: z.number(), tree: wireNodeSchema })
const callbackRefSchema = z.object({ $callback: z.string() })

function setup(bridge?: OrcaBridge) {
  const posted: Posted[] = []
  const queue: { flush: () => void; delayMs: number }[] = []
  const runtime = createOrcaDeclarativeRuntime({
    post: (event, payload) => posted.push({ event, payload }),
    schedule: (flush, delayMs) => queue.push({ flush, delayMs }),
    bridge
  })
  const drain = () => queue.splice(0).forEach(({ flush }) => flush())
  const last = () => posted.at(-1)?.payload
  const tree = (): WireNode => renderSchema.parse(last()).tree
  const { document } = runtime
  const event = (revision: number, callback: string, args: unknown[] = [], edit?: number) =>
    runtime.dispatchEvent({ document, revision, callback, args, edit })
  const ack = (revision: number, accepted = true, retryAfterMs?: number) =>
    runtime.acknowledge({ document, revision, accepted, retryAfterMs })
  return { runtime, posted, queue, drain, last, tree, event, ack }
}

function callbackAt(node: WireNode, prop: string, ...path: number[]): string {
  let current = node
  for (const index of path) {
    current = wireNodeSchema.parse(current.children[index])
  }
  return callbackRefSchema.parse(current.props[prop]).$callback
}

describe('declarative runtime', () => {
  it('renders function components into keyed catalog nodes with callback refs', () => {
    const { runtime, last, tree, event } = setup()
    const onPress = vi.fn()
    const Greeting = (props: { name?: unknown }) => h('Text', { tone: 'accent' }, 'Hi ', props.name)
    runtime.mount(() =>
      jsx('Stack', {
        gap: 'sm',
        children: [h(Greeting, { name: 'Ada' }), h('Button', { onPress, key: 'go' }, 'Go')]
      })
    )
    expect(last()).toMatchObject({
      document: runtime.document,
      revision: 1,
      tree: {
        type: 'Stack',
        key: '#0',
        children: [
          { type: 'Text', key: '#0', props: { tone: 'accent' }, children: ['Hi ', 'Ada'] },
          { type: 'Button', key: 'go', props: { onPress: { $callback: expect.any(String) } } }
        ]
      }
    })
    expect(parsePluginDeclarativeTree(tree()).ok).toBe(true)
    expect(event(1, callbackAt(tree(), 'onPress', 1))).toBe(true)
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('keeps a slot for every null/false gap, so siblings keep their keys', () => {
    const { runtime, drain, tree } = setup()
    const shown = atom(false)
    runtime.mount(() =>
      h('Stack', null, read(shown) && h('Spinner', { label: 'x' }), h('Input', { label: 'Name' }))
    )
    expect(tree().children).toEqual([expect.objectContaining({ type: 'Input', key: '#1' })])
    set(shown, true)
    drain()
    expect(tree().children).toEqual([
      expect.objectContaining({ type: 'Spinner', key: '#0' }),
      expect.objectContaining({ type: 'Input', key: '#1' })
    ])
  })

  it("carries a component's key to what it renders, and scopes nested arrays", () => {
    const { runtime, tree } = setup()
    const Row = (props: { label?: unknown }) => h('Text', null, props.label)
    runtime.mount(() =>
      h(
        'Stack',
        null,
        [h(Row, { key: 'a', label: 'A' }), h(Row, { key: 'b', label: 'B' })],
        h(Fragment, null, 'x')
      )
    )
    expect(
      tree().children.map((child) => (typeof child === 'string' ? undefined : child.key))
    ).toEqual(['#0.a', '#0.b', undefined])
  })

  it('rejects duplicate sibling keys without committing', () => {
    const { runtime, posted } = setup()
    runtime.mount(() => h('Stack', null, [h('Text', { key: 'x' }), h('Text', { key: 'x' })]))
    expect(posted).toEqual([
      {
        event: 'ui.error',
        payload: {
          document: runtime.document,
          revision: 0,
          message: expect.stringContaining('duplicate key "x"'),
          stack: expect.any(String)
        }
      }
    ])
  })

  it('runs exactly the handler of the tree on screen, never an unshown render', () => {
    const { runtime, drain, tree, event, ack } = setup()
    const target = atom('A')
    const deleted: string[] = []
    runtime.mount(() => {
      const name = read(target)
      return h('Button', { key: 'delete', onPress: () => deleted.push(name) }, `Delete ${name}`)
    })
    const id = callbackAt(tree(), 'onPress')
    ack(1)
    set(target, 'B')
    drain()
    // Revision 2 ("Delete B") is posted but not yet shown; the person clicks "Delete A".
    expect(callbackAt(tree(), 'onPress')).toBe(id)
    expect(event(1, id)).toBe(true)
    expect(deleted).toEqual(['A'])
    ack(2)
    expect(event(1, id)).toBe(false)
    expect(event(2, id)).toBe(true)
    expect(deleted).toEqual(['A', 'B'])
  })

  it('ignores events and acks for another document', () => {
    const { runtime, tree } = setup()
    const onPress = vi.fn()
    runtime.mount(() => h('Button', { onPress }, 'x'))
    const callback = callbackAt(tree(), 'onPress')
    expect(runtime.dispatchEvent({ document: 'other', revision: 1, callback, args: [] })).toBe(
      false
    )
    expect(runtime.dispatchEvent('nonsense')).toBe(false)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('keeps the shown render resolvable when the host refuses a newer one, and retries', () => {
    const { runtime, drain, tree, queue, event, ack } = setup()
    const page = atom('a')
    const onA = vi.fn()
    runtime.mount(() =>
      read(page) === 'a' ? h('Button', { onPress: onA }, 'A') : h('Text', null, 'b')
    )
    const id = callbackAt(tree(), 'onPress')
    ack(1)
    set(page, 'b')
    drain()
    ack(2, false, 250)
    expect(event(1, id)).toBe(true)
    expect(onA).toHaveBeenCalledOnce()
    expect(queue.at(-1)?.delayMs).toBeGreaterThanOrEqual(250)
    drain()
    expect(tree().children).toEqual(['b'])
    ack(3)
    expect(event(1, id)).toBe(false)
  })

  it('tags value controls with the newest edit processed, and re-renders for each edit', () => {
    const { runtime, drain, tree, event, ack } = setup()
    const draft = atom('')
    runtime.mount(() =>
      h('Input', { label: 'Title', value: read(draft), onChange: () => undefined })
    )
    expect(tree().props).toMatchObject({ value: '', $edit: 0 })
    const id = callbackAt(tree(), 'onChange')
    ack(1)
    // The plugin ignores the edit, yet the next render still reports it as seen.
    expect(event(1, id, ['a'], 1)).toBe(true)
    drain()
    expect(tree().props).toMatchObject({ value: '', $edit: 1 })
  })

  it('throttles renders and coalesces a burst of updates into one', () => {
    let clock = 0
    const posted: unknown[] = []
    const queue: { flush: () => void; delayMs: number }[] = []
    const runtime = createOrcaDeclarativeRuntime({
      post: (_event, payload) => posted.push(payload),
      schedule: (flush, delayMs) => queue.push({ flush, delayMs }),
      now: () => clock
    })
    const count = atom(0)
    runtime.mount(() => h('Text', null, String(read(count))))
    set(count, 1)
    update(count, (n) => n + 1)
    expect(queue).toHaveLength(1)
    expect(queue[0].delayMs).toBeGreaterThan(0)
    clock = 100
    queue.splice(0).forEach(({ flush }) => flush())
    expect(posted).toHaveLength(2)
  })

  it('refuses writes during render, writes to read-only atoms, and value-style update()', () => {
    const { runtime, posted } = setup()
    const count = atom(0)
    runtime.mount(() => {
      set(count, 1)
      return h('Text', null, 'x')
    })
    expect(posted.at(-1)).toMatchObject({
      event: 'ui.error',
      payload: { message: expect.stringContaining('while rendering') }
    })
    const total = derived(() => read(count) * 2)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately passes a non-function to check the runtime error.
    expect(() => update(count, 5 as unknown as (n: number) => number)).toThrow(/updater function/)
    expect(() => set(total, 3)).toThrow(/read-only/)
    const fn = (): string => 'stored'
    const holder = atom<() => string>(() => 'initial')
    set(holder, fn)
    expect(read(holder)).toBe(fn)
    expect(read(total)).toBe(0)
  })

  it('subscribes a render to what a derived atom reads', () => {
    const { runtime, drain, tree } = setup()
    const items = atom([1, 2, 3])
    const total = derived(() => read(items).reduce((sum, n) => sum + n, 0))
    runtime.mount(() => h('Text', null, String(read(total))))
    expect(tree().children).toEqual(['6'])
    update(items, (list) => [...list, 4])
    drain()
    expect(tree().children).toEqual(['10'])
  })

  it('reports props that are not plain JSON instead of posting them', () => {
    const { runtime, posted } = setup()
    runtime.mount(() => h('Text', { tone: new Date(0) }, 'x'))
    runtime.mount(() => h('Select', { label: 'x', options: [{ value: 'a', label: new Map() }] }))
    expect(posted.map((entry) => entry.event)).toEqual(['ui.error', 'ui.error'])
    expect(posted[0].payload).toMatchObject({
      message: expect.stringContaining('plain JSON data, not Date')
    })
  })

  it('passes unknown components through for the host to draw as placeholders, but not DOM tags', () => {
    const { runtime, posted } = setup()
    runtime.mount(() => h('Carousel', null))
    expect(posted[0]).toMatchObject({ event: 'ui.render', payload: { tree: { type: 'Carousel' } } })
    runtime.mount(() => h('div', null))
    expect(posted[1]).toMatchObject({
      event: 'ui.error',
      payload: { message: expect.stringContaining('<div>') }
    })
  })

  it('reports render and handler errors without dropping the last good revision', async () => {
    const { runtime, posted, drain, last, tree, event } = setup()
    const broken = atom(false)
    runtime.mount(() => {
      if (read(broken)) {
        throw new Error('boom')
      }
      return h('Button', { onPress: () => Promise.reject(new Error('async boom')) }, 'ok')
    })
    const id = callbackAt(tree(), 'onPress')
    set(broken, true)
    drain()
    expect(posted.at(-1)).toEqual({
      event: 'ui.error',
      payload: {
        document: runtime.document,
        revision: 1,
        message: 'boom',
        stack: expect.stringContaining('declarative-renderer.test.ts')
      }
    })
    expect(event(1, id)).toBe(true)
    await Promise.resolve()
    expect(last()).toMatchObject({ revision: 1, message: 'async boom' })
    set(broken, false)
    drain()
    expect(last()).toMatchObject({ revision: 2 })
  })

  it('stops a self-rendering component with an error instead of overflowing the stack', () => {
    const { runtime, last } = setup()
    const Loop = (): unknown => h(Loop, null)
    runtime.mount(Loop)
    expect(last()).toMatchObject({ message: expect.stringMatching(/deeper than/) })
  })

  it('posts an empty tree and drops callbacks on unmount', () => {
    const { runtime, last, tree, event } = setup()
    runtime.mount(() => h('Button', { onPress: () => undefined }, 'x'))
    const id = callbackAt(tree(), 'onPress')
    expect(runtime.mounted()).toBe(true)
    runtime.unmount()
    expect(runtime.mounted()).toBe(false)
    expect(last()).toEqual({ document: runtime.document, revision: 2, tree: null })
    expect(event(1, id)).toBe(false)
  })

  it('follows theme changes from the bridge and stops listening on dispose', () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const bridge: OrcaBridge = {
      on: (name, handler) => {
        handlers.set(name, handler)
        return { dispose: () => handlers.delete(name) }
      }
    }
    const { runtime, drain, last } = setup(bridge)
    runtime.mount(() => h('Text', null, read(runtime.themeAtom).colorScheme))
    expect(last()).toMatchObject({ tree: { children: ['dark'] } })
    handlers.get('theme')?.({ colorScheme: 'light' })
    drain()
    expect(last()).toMatchObject({ tree: { children: ['light'] } })
    expect([...handlers.keys()].sort()).toEqual([
      'theme',
      'ui.ack',
      'ui.event',
      'ui.hydrate',
      'ui.restore',
      'ui.snapshot',
      'ui.visibility'
    ])
    runtime.dispose()
    expect(handlers.size).toBe(0)
  })
})
