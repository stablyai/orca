import { beforeEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getWorktreeJumpPaletteAnnouncement } from './WorktreeJumpPalette'

describe('WorktreeJumpPalette localized announcements', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each([
    [true, 1, false, '1 result found'],
    [true, 2, false, '2 results found'],
    [true, 1, true, '1 result found; create worktree action available'],
    [true, 2, true, '2 results found; create worktree action available'],
    [false, 1, false, '1 item available'],
    [false, 2, false, '2 items available'],
    [false, 1, true, '1 item available; create worktree action available'],
    [false, 2, true, '2 items available; create worktree action available']
  ])('formats query=%s count=%s create=%s', (hasQuery, resultCount, showCreateAction, expected) => {
    expect(getWorktreeJumpPaletteAnnouncement({ hasQuery, resultCount, showCreateAction })).toBe(
      expected
    )
  })
})
