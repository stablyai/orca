import { describe, expect, it } from 'vitest'
import { getShortcutActionIntentState } from './ShortcutsPane'
import { getShortcutActionIntentSignal } from './settings-shortcut-intent'

describe('ShortcutsPane shortcut action intent', () => {
  it('sets local search to the action title and resets the status filter', () => {
    expect(getShortcutActionIntentState('terminal.splitRight')).toEqual({
      query: 'Split terminal right',
      filter: 'all'
    })
  })

  it('falls back to the action id if the definition disappeared', () => {
    const missingActionId = 'missing.action' as Parameters<typeof getShortcutActionIntentState>[0]

    expect(getShortcutActionIntentState(missingActionId)).toEqual({
      query: 'missing.action',
      filter: 'all'
    })
  })

  it('preserves repeated Settings shortcut-action targets with a new request signal', () => {
    const first = getShortcutActionIntentSignal(
      {
        pane: 'shortcuts',
        repoId: null,
        intent: 'shortcut-action',
        actionId: 'terminal.splitRight'
      },
      null
    )
    const second = getShortcutActionIntentSignal(
      {
        pane: 'shortcuts',
        repoId: null,
        intent: 'shortcut-action',
        actionId: 'terminal.splitRight'
      },
      first
    )

    expect(first).toEqual({ actionId: 'terminal.splitRight', requestId: 1 })
    expect(second).toEqual({ actionId: 'terminal.splitRight', requestId: 2 })
  })

  it('ignores non-shortcut Settings targets before ShortcutsPane handoff', () => {
    expect(
      getShortcutActionIntentSignal(
        {
          pane: 'quick-commands',
          repoId: null,
          intent: 'add-quick-command'
        },
        { actionId: 'terminal.splitRight', requestId: 1 }
      )
    ).toBeNull()
  })
})
