import { describe, expect, it } from 'vitest'
import { planLabelToggle } from './plan-label-toggle'

describe('planLabelToggle', () => {
  it('toggles a label on a single workspace', () => {
    expect(planLabelToggle([{ id: 'w1', labelIds: ['a'] }], 'b')).toEqual([
      { id: 'w1', labelIds: ['a', 'b'] }
    ])
    expect(planLabelToggle([{ id: 'w1', labelIds: ['a', 'b'] }], 'b')).toEqual([
      { id: 'w1', labelIds: ['a'] }
    ])
  })

  it('adds the label only where it is missing when the selection is mixed', () => {
    expect(
      planLabelToggle(
        [
          { id: 'w1', labelIds: ['b'] },
          { id: 'w2', labelIds: [] }
        ],
        'b'
      )
    ).toEqual([{ id: 'w2', labelIds: ['b'] }])
  })

  it('removes the label from every workspace when all have it', () => {
    expect(
      planLabelToggle(
        [
          { id: 'w1', labelIds: ['b', 'a'] },
          { id: 'w2', labelIds: ['b'] }
        ],
        'b'
      )
    ).toEqual([
      { id: 'w1', labelIds: ['a'] },
      { id: 'w2', labelIds: [] }
    ])
  })
})
