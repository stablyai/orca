import { describe, expect, it } from 'vitest'

import { getProjectSpaceMenuOptions } from './project-space-menu-options'
import { DEFAULT_SPACE_ID, createDefaultSpace } from '../../../../shared/spaces'
import type { Space } from '../../../../shared/types'

function makeSpace(id: string, name: string, emoji: string, createdAt: number): Space {
  return { id, name, emoji, createdAt, updatedAt: createdAt }
}

const DEFAULT_SPACE = createDefaultSpace(1)
const WORK_SPACE = makeSpace('space-work', 'Work', '💼', 1)
const SIDE_SPACE = makeSpace('space-side', 'Side', '🚀', 2)

describe('getProjectSpaceMenuOptions', () => {
  it('stays hidden without custom Spaces and for runtime-owned projects', () => {
    expect(getProjectSpaceMenuOptions([DEFAULT_SPACE], null)).toEqual([])
    expect(getProjectSpaceMenuOptions([DEFAULT_SPACE, WORK_SPACE], null, 'runtime:server')).toEqual(
      []
    )
  })

  it('maps every Space in catalog order with the correct move target and selection', () => {
    const options = getProjectSpaceMenuOptions([DEFAULT_SPACE, WORK_SPACE, SIDE_SPACE], null)

    expect(
      options.map(({ spaceId, targetSpaceId, emoji, name, selected }) => [
        spaceId,
        targetSpaceId,
        emoji,
        name,
        selected
      ])
    ).toEqual([
      [DEFAULT_SPACE_ID, null, null, 'Default', true],
      ['space-work', 'space-work', '💼', 'Work', false],
      ['space-side', 'space-side', '🚀', 'Side', false]
    ])
  })

  it('selects only a known current Space', () => {
    expect(
      getProjectSpaceMenuOptions([DEFAULT_SPACE, WORK_SPACE], 'space-work').find(
        (option) => option.selected
      )?.spaceId
    ).toBe('space-work')
    expect(
      getProjectSpaceMenuOptions([DEFAULT_SPACE, WORK_SPACE], 'space-deleted').some(
        (option) => option.selected
      )
    ).toBe(false)
  })
})
