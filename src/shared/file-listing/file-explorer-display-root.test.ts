import { describe, expect, it } from 'vitest'
import { normalizeExplorerDisplayRootByWorktree } from './file-explorer-display-root'

describe('explorer root persistence', () => {
  it('rejects malformed records and unsafe keys', () => {
    expect(normalizeExplorerDisplayRootByWorktree(['src'])).toEqual({})
    expect(
      normalizeExplorerDisplayRootByWorktree(
        JSON.parse('{"__proto__":"src","constructor":"src","ok":"/","bad":false}')
      )
    ).toEqual({ ok: '/' })
  })
})
