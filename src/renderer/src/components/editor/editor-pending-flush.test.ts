import { expect, it, vi } from 'vitest'
import {
  flushClosingEditorBuffers,
  flushPendingEditorBuffer,
  hasPendingEditorBufferChange,
  registerPendingEditorFlush
} from './editor-pending-flush'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX as NO_SHARING } from '@/store/slices/editor/buffers/editor-buffer-views'

it('retains legacy replacement semantics and independently cleans up registrations', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('legacy', earlier)
  const removeLater = registerPendingEditorFlush('legacy', later)
  try {
    flushPendingEditorBuffer(NO_SHARING, 'legacy')
    expect(earlier).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledTimes(1)
    removeEarlier()
    flushPendingEditorBuffer(NO_SHARING, 'legacy')
    expect(later).toHaveBeenCalledTimes(2)
  } finally {
    removeEarlier()
    removeLater()
  }
  flushPendingEditorBuffer(NO_SHARING, 'legacy')
  expect(later).toHaveBeenCalledTimes(2)
})

it('checks pending changes across panes and retains the remaining registration on cleanup', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('panes', earlier, () => true)
  const removeLater = registerPendingEditorFlush('panes', later, () => false)
  try {
    expect(hasPendingEditorBufferChange(NO_SHARING, 'panes')).toBe(true)
    removeLater()
    flushPendingEditorBuffer(NO_SHARING, 'panes')
    expect(earlier).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  } finally {
    removeEarlier()
    removeLater()
  }
  expect(hasPendingEditorBufferChange(NO_SHARING, 'panes')).toBe(false)
})

it('flushes every pane of closing files and leaves other files editing', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const failingPane = vi.fn(() => {
    throw new Error('serialize failed')
  })
  const typingPane = vi.fn()
  const keepFailedInput = vi.fn()
  const keepTypedInput = vi.fn()
  const closingCell = vi.fn()
  const survivingCell = vi.fn()
  const removers = [
    registerPendingEditorFlush('rich', typingPane, undefined, keepTypedInput),
    registerPendingEditorFlush('rich', failingPane, undefined, keepFailedInput),
    registerPendingEditorFlush('csv', closingCell, () => false),
    registerPendingEditorFlush('survivor', survivingCell, () => true)
  ]
  try {
    flushClosingEditorBuffers(NO_SHARING, ['rich', 'csv'])
    expect(typingPane).toHaveBeenCalledTimes(1)
    expect(failingPane).toHaveBeenCalledTimes(1)
    expect(keepFailedInput).toHaveBeenCalledTimes(1)
    expect(keepTypedInput).not.toHaveBeenCalled()
    expect(closingCell).toHaveBeenCalledTimes(1)
    expect(survivingCell).not.toHaveBeenCalled()
  } finally {
    removers.forEach((remove) => remove())
  }
})
