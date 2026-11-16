// SHARE-LINKS-HOLD: ⌘⌥⇧L (Copy cloud workspace link) is listed in Settings › Shortcuts and its
// search only while share links are on.
import { describe, expect, it, vi } from 'vitest'

const shareLinks = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/orca-cloud/cloud-share-links-flag', () => ({
  CLOUD_SHARE_LINK_ACTION_ID: 'cloudWorkspace.copyLink',
  cloudShareLinksEnabled: () => shareLinks.on
}))

import { groupDefinitions } from './shortcut-groups'
import { getShortcutsPaneSearchEntries } from './shortcuts-search'

const listed = (): string[] =>
  groupDefinitions([]).flatMap((group) => group.items.map((item) => item.id))
const searched = (): string[] => getShortcutsPaneSearchEntries().map((entry) => entry.title)

describe('the share-link shortcut in Settings', () => {
  it('held: not listed and not searchable', () => {
    shareLinks.on = false
    expect(listed()).not.toContain('cloudWorkspace.copyLink')
    expect(searched()).not.toContain('Copy cloud workspace link')
  })

  it('on: listed and searchable', () => {
    shareLinks.on = true
    expect(listed()).toContain('cloudWorkspace.copyLink')
    expect(searched()).toContain('Copy cloud workspace link')
  })
})
