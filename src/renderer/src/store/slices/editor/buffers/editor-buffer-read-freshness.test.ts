import { expect, it } from 'vitest'
import {
  beginEditorBufferRead,
  isEditorBufferReadCurrent,
  beginEditorBufferFileRead,
  markEditorBufferNewer,
  peekEditorBufferFreshness,
  supersedePanelEditorBufferRead,
  trackPanelEditorBufferRead
} from './editor-buffer-read-freshness'

it("an older read can't land after a newer reload of the same file from another panel", () => {
  const panelARead = beginEditorBufferRead('record-1')
  // Disk changes; panel B reloads.
  const panelBReload = beginEditorBufferRead('record-1')

  expect(isEditorBufferReadCurrent('record-1', panelARead)).toBe(false)
  // Publishing A's result would not have moved the counter, so B's newer read still lands.
  expect(isEditorBufferReadCurrent('record-1', panelBReload)).toBe(true)
})

it("a read that started before a save can't land after it", () => {
  const read = beginEditorBufferRead('record-2')
  markEditorBufferNewer('record-2')

  expect(isEditorBufferReadCurrent('record-2', read)).toBe(false)
})

it("one file's reads don't supersede another's", () => {
  const read = beginEditorBufferRead('record-3')
  beginEditorBufferRead('record-4')

  expect(isEditorBufferReadCurrent('record-3', read)).toBe(true)
})

it("Keep's signature-only read doesn't supersede a panel's first content read", () => {
  const panelRead = beginEditorBufferRead('record-5')
  const keepToken = peekEditorBufferFreshness('record-5')

  expect(isEditorBufferReadCurrent('record-5', panelRead)).toBe(true)
  expect(isEditorBufferReadCurrent('record-5', keepToken)).toBe(true)
})

it("invalidating a panel's older read never cancels a newer read in another panel", () => {
  const panelA = { current: {} }
  const olderRead = beginEditorBufferFileRead({}, 'record-6')
  trackPanelEditorBufferRead(panelA, 'record-6', olderRead)
  const newerReload = beginEditorBufferFileRead({}, 'record-6')

  supersedePanelEditorBufferRead(panelA, 'record-6')

  expect(newerReload.isCurrent()).toBe(true)
})

it("invalidating a panel's read that is still the newest cancels it", () => {
  const panel = { current: {} }
  const read = beginEditorBufferFileRead({}, 'record-7')
  trackPanelEditorBufferRead(panel, 'record-7', read)

  supersedePanelEditorBufferRead(panel, 'record-7')

  expect(read.isCurrent()).toBe(false)
})
