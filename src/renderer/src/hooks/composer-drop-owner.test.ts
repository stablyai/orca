import { describe, expect, it } from 'vitest'
import { isCurrentComposerDropOwner } from './composer-drop-owner'

describe('composer drop owner', () => {
  it('keeps the top mounted composer as the only drop owner', () => {
    const page = Symbol('page')
    const modal = Symbol('modal')

    expect(isCurrentComposerDropOwner([page], page)).toBe(true)
    expect(isCurrentComposerDropOwner([page, modal], page)).toBe(false)
    expect(isCurrentComposerDropOwner([page, modal], modal)).toBe(true)
  })

  it('rejects async drop completions after their owner unmounts', () => {
    const owner = Symbol('owner')

    expect(isCurrentComposerDropOwner([], owner)).toBe(false)
  })
})
