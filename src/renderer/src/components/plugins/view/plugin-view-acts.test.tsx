// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import type { PluginDeclarativeNode } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginShotAct } from '../../../../../shared/plugins/view/plugin-shot-acts'
import { PluginDeclarativeView } from '../declarative/PluginDeclarativeView'
import type { PluginDeclarativeEmit } from '../declarative/PluginDeclarativeControls'
import { pluginDeclarativeActTarget } from '../declarative/plugin-declarative-act-targets'
import type { PluginPanelActDriver } from '../../right-sidebar/plugin-panel-act-driver'
import { runPluginPanelActs } from './plugin-view-acts'

afterEach(cleanup)

const cb = (id: string) => ({ $callback: id })
const node = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({
  type,
  props,
  children
})

function parse(raw: unknown): PluginDeclarativeNode {
  const parsed = parsePluginDeclarativeTree(raw)
  if (!parsed.ok || !parsed.tree) {
    throw new Error(parsed.ok ? 'empty tree' : parsed.error)
  }
  return parsed.tree
}

/** A tiny todo guest: Orca draws its tree, and its callbacks re-render it, as a real guest's do. */
function mountTodoGuest() {
  const tasks: string[] = []
  const state = { draft: '', edit: 0, tasks, hideDone: false }
  const sent: { callback: string; args: unknown[]; edit?: number }[] = []
  const listeners = new Set<() => void>()
  let tree: PluginDeclarativeNode | null = null
  const build = () =>
    parse(
      node('Stack', {}, [
        node('Input', {
          label: 'New task',
          value: state.draft,
          $edit: state.edit,
          onChange: cb('draft'),
          onSubmit: cb('submit')
        }),
        node('Button', { onPress: cb('add') }, ['Add']),
        node('Button', { onPress: cb('never'), disabled: true }, ['Archive']),
        node('Link', { href: 'https://example.com' }, ['Docs']),
        node('Input', { label: 'Locked', value: 'fixed' }),
        node('Switch', { label: 'Hide done', checked: state.hideDone, onChange: cb('hide') }),
        node('Tabs', { label: 'View', defaultValue: 'all' }, [
          node('Tab', { value: 'all', label: 'All' }, [
            node(
              'List',
              { label: 'Tasks' },
              state.tasks.map((title) => node('ListItem', { title }))
            )
          ]),
          node('Tab', { value: 'done', label: 'Done' }, [node('Text', {}, ['Nothing done yet'])])
        ])
      ])
    )
  const handle = (callback: string, args: unknown[], edit?: number): void => {
    sent.push({ callback, args, ...(edit === undefined ? {} : { edit }) })
    if (callback === 'draft' && typeof args[0] === 'string') {
      state.draft = args[0]
      state.edit = Math.max(state.edit, edit ?? 0)
    } else if (callback === 'submit' || callback === 'add') {
      if (state.draft) {
        state.tasks.push(state.draft)
      }
      state.draft = ''
    } else if (callback === 'hide') {
      state.hideDone = args[0] === true
    }
    draw()
  }
  const onEvent: PluginDeclarativeEmit = (callback, args, options = {}) =>
    handle(callback, args, options.edit)
  const view = () => (
    <TooltipProvider>
      <PluginDeclarativeView tree={tree} onEvent={onEvent} />
    </TooltipProvider>
  )
  const result = render(view())
  function draw(): void {
    tree = build()
    result.rerender(view())
    listeners.forEach((listener) => listener())
  }
  act(() => draw())
  const driver: PluginPanelActDriver = {
    tree: () => tree,
    send: (callback, args) => act(() => handle(callback, args)),
    onDraw: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const run = (acts: PluginShotAct[]) =>
    runPluginPanelActs(acts, {
      driver,
      targetOf: pluginDeclarativeActTarget,
      settle: () => act(async () => {})
    })
  return { state, sent, run }
}

describe('runPluginPanelActs', () => {
  it("types, submits and presses through Orca's own controls", async () => {
    const guest = mountTodoGuest()
    const results = await guest.run([
      { type: { label: 'New task' }, text: 'Ship', submit: true },
      { type: { label: 'New task' }, text: 'Docs' },
      { press: { text: 'Add' } }
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    expect(guest.state.tasks).toEqual(['Ship', 'Docs'])
    // Each character is an edit the guest sees; the submit sends what is on screen.
    expect(
      guest.sent.filter((each) => each.callback === 'draft').map((each) => each.args[0])
    ).toEqual(['S', 'Sh', 'Shi', 'Ship', 'D', 'Do', 'Doc', 'Docs'])
    expect(guest.sent.find((each) => each.callback === 'submit')?.args).toEqual(['Ship'])
    expect(screen.getByRole('textbox', { name: 'New task' })).toHaveProperty('value', '')
    expect(screen.getByText('Ship')).toBeTruthy()
  })

  it('toggles a Switch and selects a tab, then finds what the tab shows', async () => {
    const guest = mountTodoGuest()
    const results = await guest.run([
      { toggle: { label: 'Hide done' } },
      { select: { label: 'View' }, value: 'done' },
      { press: { text: 'Nothing done yet' } }
    ])
    expect(guest.state.hideDone).toBe(true)
    expect(screen.getByText('Nothing done yet')).toBeTruthy()
    expect(results.slice(0, 2)).toEqual([{ ok: true }, { ok: true }])
    // Found on the shown tab, but a Text has nothing to press.
    expect(results[2]).toEqual({ ok: false, error: 'press: the Text has no onPress' })
  })

  it('stops at the first failure and says why', async () => {
    const guest = mountTodoGuest()
    expect(await guest.run([{ press: { text: 'Remove' } }, { press: { text: 'Add' } }])).toEqual([
      { ok: false, error: 'press: nothing in the panel matches { text: "Remove" }' },
      { ok: false, error: 'not run: an earlier action failed' }
    ])
    expect(guest.sent).toEqual([])
    const failures = await Promise.all(
      (
        [
          { press: { text: 'Archive' } },
          { press: { text: 'Docs' } },
          { type: { text: 'Add' }, text: 'x' },
          { type: { label: 'Locked' }, text: 'x' },
          { select: { label: 'View' }, value: 'later' },
          { toggle: { label: 'New task' } }
        ] satisfies PluginShotAct[]
      ).map(async (each) => (await guest.run([each]))[0])
    )
    expect(failures).toEqual([
      { ok: false, error: 'press: the Button is disabled' },
      { ok: false, error: "press: --act does not open a Link's href; only a person's click does" },
      { ok: false, error: 'type: expected an Input or Textarea, not a Button' },
      { ok: false, error: 'type: the Input is read-only (a value and no onChange)' },
      { ok: false, error: 'select: the Tabs has no enabled option "later"' },
      { ok: false, error: 'toggle: expected a Switch, Checkbox or Collapsible, not a Input' }
    ])
  })
})
