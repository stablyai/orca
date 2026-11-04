// @vitest-environment happy-dom
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginShotAct } from '../../../../../shared/plugins/view/plugin-shot-acts'
import { cb, mountActGuest, node } from './plugin-view-act-test-harness'

afterEach(cleanup)

/** A tiny todo guest. */
function mountTodoGuest() {
  const tasks: string[] = []
  const state = { draft: '', edit: 0, tasks, hideDone: false }
  const { sent, run } = mountActGuest(
    () =>
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
      ]),
    ({ callback, args, edit }) => {
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
    }
  )
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
