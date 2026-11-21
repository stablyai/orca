// @vitest-environment happy-dom

import { renderHook, cleanup, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useCsvTableEditor } from './editing/useCsvTableEditor'
import { parseCsvTextDocument } from './document/csv-text-document'

afterEach(() => {
  cleanup()
})

describe('editable CSV table', () => {
  it('applies a pending cell and a subsequent structural mutation atomically', () => {
    const changes = vi.fn()
    const { result } = renderHook(() =>
      useCsvTableEditor({
        document: parseCsvTextDocument('name,value\nB,2', ','),
        inspectionRows: null,
        onContentChange: changes,
        onStructureChange: vi.fn()
      })
    )
    act(() => result.current.edit(1, 0))
    act(() => result.current.interaction?.change('pending'))
    act(() =>
      expect(result.current.apply({ kind: 'insert-column', at: 1, label: 'new' })).toBe(true)
    )
    expect(changes).toHaveBeenCalledExactlyOnceWith('name,new,value\npending,,2')
    expect(result.current.interaction?.editing).toBeNull()
  })
})
