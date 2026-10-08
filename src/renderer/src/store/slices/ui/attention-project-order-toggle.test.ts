import { describe, expect, it } from 'vitest'
import { resolveAttentionProjectOrderToggle } from './attention-project-order-toggle'

describe('resolveAttentionProjectOrderToggle', () => {
  it('turns on attention order and compact rows, remembering the previous choice', () => {
    expect(
      resolveAttentionProjectOrderToggle({
        projectOrderBy: 'recent',
        compactProjectRows: false,
        restore: null
      })
    ).toEqual({
      projectOrderBy: 'attention',
      compactProjectRows: true,
      restore: { projectOrderBy: 'recent', compactProjectRows: false }
    })
  })

  it('restores the remembered order and compact choice when turned off', () => {
    expect(
      resolveAttentionProjectOrderToggle({
        projectOrderBy: 'attention',
        compactProjectRows: true,
        restore: { projectOrderBy: 'recent', compactProjectRows: false }
      })
    ).toEqual({ projectOrderBy: 'recent', compactProjectRows: false, restore: null })
  })

  it('falls back to manual and keeps compact rows when nothing was remembered', () => {
    expect(
      resolveAttentionProjectOrderToggle({
        projectOrderBy: 'attention',
        compactProjectRows: true,
        restore: null
      })
    ).toEqual({ projectOrderBy: 'manual', compactProjectRows: true, restore: null })
  })
})
