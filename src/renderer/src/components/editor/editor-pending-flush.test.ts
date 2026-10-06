import { expect, it, vi } from 'vitest'
import {
  flushPendingEditorChange,
  hasPendingEditorChange,
  registerPendingEditorFlush
} from './editor-pending-flush'

it('retains legacy replacement semantics and independently cleans up registrations', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('legacy', earlier)
  const removeLater = registerPendingEditorFlush('legacy', later)
  try {
    flushPendingEditorChange('legacy')
    expect(earlier).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledTimes(1)
    removeEarlier()
    flushPendingEditorChange('legacy')
    expect(later).toHaveBeenCalledTimes(2)
  } finally {
    removeEarlier()
    removeLater()
  }
  flushPendingEditorChange('legacy')
  expect(later).toHaveBeenCalledTimes(2)
})

it('checks pending changes across panes and retains the remaining registration on cleanup', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('panes', earlier, () => true)
  const removeLater = registerPendingEditorFlush('panes', later, () => false)
  try {
    expect(hasPendingEditorChange('panes')).toBe(true)
    removeLater()
    flushPendingEditorChange('panes')
    expect(earlier).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  } finally {
    removeEarlier()
    removeLater()
  }
  expect(hasPendingEditorChange('panes')).toBe(false)
})
