import { describe, it, expect } from 'vitest'
import { selectionPayload, openEditorsPayload } from './claude-ide-context'

describe('claude-ide-context', () => {
  it('selectionPayload maps editor selection to protocol shape', () => {
    expect(selectionPayload({ text: 'hi', filePath: '/w/a.ts' })).toEqual({ text: 'hi', filePath: '/w/a.ts' })
    expect(selectionPayload(null)).toBeNull()
  })

  it('openEditorsPayload maps tabs to {filePath,isDirty}', () => {
    expect(openEditorsPayload([{ path: '/w/a.ts', dirty: true }])).toEqual([{ filePath: '/w/a.ts', isDirty: true }])
  })
})
