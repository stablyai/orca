import { describe, expect, it } from 'vitest'
import { isLinkEditCancelShortcut } from './RichMarkdownLinkBubble'

describe('isLinkEditCancelShortcut', () => {
  it('uses only the platform primary modifier for link-edit cancellation', () => {
    expect(isLinkEditCancelShortcut({ key: 'k', metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(isLinkEditCancelShortcut({ key: 'k', metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(isLinkEditCancelShortcut({ key: 'k', metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(isLinkEditCancelShortcut({ key: 'k', metaKey: true, ctrlKey: false }, false)).toBe(false)
  })
})
