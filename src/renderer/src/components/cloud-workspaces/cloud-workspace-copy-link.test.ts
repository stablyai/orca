import { beforeEach, describe, expect, it, vi } from 'vitest'

const copy = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./open-cloud-workspace', () => ({
  copyCloudWorkspaceLink: copy,
  openCloudWorkspace: vi.fn()
}))

import { copyShortcutLink, focusedKind } from './cloud-workspace-links'

const ID = 'sbx_00000000000000000000c197'

describe('copy link (⌘⌥⇧L)', () => {
  beforeEach(() => copy.mockClear())

  it('copies the workspace link only, never the focused chat or terminal', async () => {
    await copyShortcutLink(ID)
    expect(copy).toHaveBeenCalledWith(ID, null)
  })

  it('names the focused item for the separate menu row', () => {
    expect(focusedKind('t:term_1')).toBe('terminal')
    expect(focusedKind('s:session_1')).toBe('chat')
    expect(focusedKind(null)).toBeNull()
  })
})
