import { describe, expect, it } from 'vitest'
import {
  buildCodexRestartNoticeKey,
  createCodexRestartOverlayCollapseState,
  getCodexRestartOverlayCollapseState
} from './codex-restart-overlay-collapse'

describe('codex restart overlay collapse', () => {
  it('builds a stable notice key from account labels', () => {
    expect(
      buildCodexRestartNoticeKey({
        previousAccountLabel: 'Account A',
        nextAccountLabel: 'Account B'
      })
    ).toBe('Account A\u0000Account B')
  })

  it('reopens loud mode when the notice key changes', () => {
    const collapsed = {
      noticeKey: buildCodexRestartNoticeKey({
        previousAccountLabel: 'Account A',
        nextAccountLabel: 'Account B'
      }),
      collapsed: true
    }

    expect(
      getCodexRestartOverlayCollapseState(
        collapsed,
        buildCodexRestartNoticeKey({
          previousAccountLabel: 'Account A',
          nextAccountLabel: 'Account C'
        })
      )
    ).toEqual({
      noticeKey: 'Account A\u0000Account C',
      collapsed: false
    })
  })

  it('preserves collapse state for the same notice key', () => {
    const noticeKey = buildCodexRestartNoticeKey({
      previousAccountLabel: 'Account A',
      nextAccountLabel: 'Account B'
    })
    const collapsed = { noticeKey, collapsed: true }

    expect(getCodexRestartOverlayCollapseState(collapsed, noticeKey)).toBe(collapsed)
  })

  it('creates loud mode for a new notice key', () => {
    const noticeKey = buildCodexRestartNoticeKey({
      previousAccountLabel: 'Account A',
      nextAccountLabel: 'Account B'
    })

    expect(createCodexRestartOverlayCollapseState(noticeKey)).toEqual({
      noticeKey,
      collapsed: false
    })
  })
})
