import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import {
  isSourceControlSplitOpenModifier,
  resolveSideSplitDiffColumn,
  shouldOpenSourceControlRowAsPreview,
  toPermanentSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control/listing/split-open'

function event(overrides: Partial<SourceControlRowOpenEvent> = {}): SourceControlRowOpenEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('isSourceControlSplitOpenModifier', () => {
  it('uses Cmd on macOS and Ctrl elsewhere as the platform primary modifier', () => {
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), true)).toBe(false)

    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), false)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), false)).toBe(false)
  })

  it('treats Shift and Alt/Option as split-open modifiers', () => {
    expect(isSourceControlSplitOpenModifier(event({ shiftKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ altKey: true }), false)).toBe(true)
  })

  it('ignores a plain click', () => {
    expect(isSourceControlSplitOpenModifier(event(), true)).toBe(false)
    expect(isSourceControlSplitOpenModifier(event(), false)).toBe(false)
  })
})

describe('shouldOpenSourceControlRowAsPreview', () => {
  it('uses preview for plain row opens in the current group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), undefined)).toBe(true)
  })

  it('does not preview when opening into a split group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), 'group-2')).toBe(false)
  })

  it('does not preview when the row requests a permanent open', () => {
    expect(shouldOpenSourceControlRowAsPreview(event({ openAsPermanent: true }), undefined)).toBe(
      false
    )
  })
})

function tab(
  groupId: string,
  contentType: Tab['contentType'],
  isPreview?: boolean
): Pick<Tab, 'groupId' | 'contentType' | 'isPreview'> {
  return { groupId, contentType, isPreview }
}

describe('resolveSideSplitDiffColumn', () => {
  it('does not let a preview parked in the active group capture the diff column', () => {
    const tabs = [tab('group-a', 'editor', true)]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a'],
        recordedGroupId: undefined
      })
    ).toEqual({ groupId: undefined, shouldRecord: true })
  })

  it('reuses the recorded column ahead of any preview or diff tab', () => {
    const tabs = [tab('group-b', 'editor', true), tab('group-c', 'diff')]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a', 'group-b', 'group-c', 'group-d'],
        recordedGroupId: 'group-d'
      })
    ).toEqual({ groupId: 'group-d', shouldRecord: false })
  })

  it('re-infers and re-records once the recorded group is gone', () => {
    const tabs = [tab('group-a', 'terminal'), tab('group-b', 'diff', true)]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a', 'group-b'],
        recordedGroupId: 'group-gone'
      })
    ).toEqual({ groupId: 'group-b', shouldRecord: true })
  })

  it('records a parked preview that already sits in a side group', () => {
    const tabs = [
      tab('group-a', 'terminal'),
      tab('group-a', 'diff'),
      tab('group-b', 'editor', true)
    ]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a', 'group-b'],
        recordedGroupId: undefined
      })
    ).toEqual({ groupId: 'group-b', shouldRecord: true })
  })

  it('falls back to a non-active group already holding diff tabs', () => {
    const tabs = [tab('group-a', 'terminal'), tab('group-b', 'diff')]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a', 'group-b'],
        recordedGroupId: undefined
      })
    ).toEqual({ groupId: 'group-b', shouldRecord: true })
  })

  it('ignores diff tabs in the active group and terminal previews', () => {
    const tabs = [tab('group-a', 'diff'), tab('group-b', 'terminal', true)]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a', 'group-b'],
        recordedGroupId: undefined
      })
    ).toEqual({ groupId: undefined, shouldRecord: true })
  })

  it('returns undefined for a fresh worktree so the caller creates a split', () => {
    expect(
      resolveSideSplitDiffColumn({
        tabs: [],
        activeGroupId: 'group-a',
        liveGroupIds: ['group-a'],
        recordedGroupId: undefined
      })
    ).toEqual({ groupId: undefined, shouldRecord: true })
  })

  it('keeps returning the recorded split after it becomes the active group', () => {
    // Why: createEmptySplitGroup focuses the new split, so inference alone would exclude it and
    // split again on every open.
    const tabs = [tab('group-a', 'terminal'), tab('group-b', 'diff', true)]
    expect(
      resolveSideSplitDiffColumn({
        tabs,
        activeGroupId: 'group-b',
        liveGroupIds: ['group-a', 'group-b'],
        recordedGroupId: 'group-b'
      })
    ).toEqual({ groupId: 'group-b', shouldRecord: false })
  })
})

describe('toPermanentSourceControlRowOpenEvent', () => {
  it('preserves modifier keys and marks the row open as permanent', () => {
    expect(
      toPermanentSourceControlRowOpenEvent(
        event({
          altKey: true,
          metaKey: true
        })
      )
    ).toEqual({
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      openAsPermanent: true
    })
  })
})
