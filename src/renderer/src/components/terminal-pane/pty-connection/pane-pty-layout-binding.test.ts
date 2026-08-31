import { describe, expect, it } from 'vitest'

import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

describe('shouldIgnoreStalePanePtyLayoutBinding', () => {
  it('rejects a late write for the old PTY after the tab has moved on', () => {
    expect(
      shouldIgnoreStalePanePtyLayoutBinding({
        existingPtyId: 'pty-new',
        nextPtyId: 'pty-old',
        tabPtyId: 'pty-new'
      })
    ).toBe(true)
  })

  it('allows a live replacement to advance the tab and pane together', () => {
    expect(
      shouldIgnoreStalePanePtyLayoutBinding({
        existingPtyId: 'pty-old',
        nextPtyId: 'pty-new',
        tabPtyId: 'pty-new'
      })
    ).toBe(false)
  })

  it('rejects a stale callback after the pane already adopted the replacement', () => {
    expect(
      shouldIgnoreStalePanePtyLayoutBinding({
        existingPtyId: 'pty-new',
        nextPtyId: 'pty-old',
        tabPtyId: 'pty-new'
      })
    ).toBe(true)
  })

  it('allows a callback while the tab still owns the callback PTY', () => {
    expect(
      shouldIgnoreStalePanePtyLayoutBinding({
        existingPtyId: 'pty-new',
        nextPtyId: 'pty-old',
        tabPtyId: 'pty-old'
      })
    ).toBe(false)
  })
})
