import { describe, expect, it } from 'vitest'
import { isTerminalLeafId } from '../stable-pane-id'
import { nameBasedUuid } from './workspace-layout-minted-ids'

describe('nameBasedUuid', () => {
  it('is a pane-key-safe UUID that depends only on its name', () => {
    const names = ['group:repo-1::/a', 'leaf:tab-1', 'leaf:tab-1:1', 'tab:tab-1', '']
    const ids = names.map(nameBasedUuid)
    expect(ids.every(isTerminalLeafId)).toBe(true)
    expect(new Set(ids).size).toBe(names.length)
    expect(names.map(nameBasedUuid)).toEqual(ids)
  })
})
