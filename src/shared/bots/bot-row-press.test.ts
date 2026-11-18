import { describe, expect, it, vi } from 'vitest'
import { pressFoldableRow } from './bot-row-press'

function row(state: { active: boolean; folded: boolean; foldable?: boolean; opens?: boolean }) {
  const open = vi.fn(() => state.opens ?? true)
  const toggle = vi.fn()
  return {
    open,
    toggle,
    press: (press: { detail: number; repeat?: boolean }) =>
      pressFoldableRow(
        {
          active: state.active,
          folded: state.folded,
          open,
          toggle: state.foldable === false ? null : toggle
        },
        press
      )
  }
}

describe('pressFoldableRow', () => {
  it('opens a folded row that is not the open one, and unfolds it', () => {
    const { open, toggle, press } = row({ active: false, folded: true })
    press({ detail: 1 })
    expect(open).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('leaves the fold alone when the row could not open', () => {
    const { toggle, press } = row({ active: false, folded: true, opens: false })
    press({ detail: 1 })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('folds or unfolds the open row instead of opening it again', () => {
    const { open, toggle, press } = row({ active: true, folded: false })
    press({ detail: 1 })
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the open row again when it has nothing to fold', () => {
    const { open, press } = row({ active: true, folded: false, foldable: false })
    press({ detail: 1 })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("ignores a double-click's second click and a held key's repeats", () => {
    const { open, toggle, press } = row({ active: false, folded: true })
    press({ detail: 2 })
    press({ detail: 1, repeat: true })
    expect(open).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
  })
})
