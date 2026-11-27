import { describe, expect, it } from 'vitest'
import { sourceRefsForTarget } from './git-branch-cleanup-fetch'

describe('sourceRefsForTarget', () => {
  it('inserts a wildcard capture containing $ sequences literally', () => {
    // git check-ref-format accepts this name; String.replace would rewrite $$ to $.
    expect(
      sourceRefsForTarget(['+refs/heads/*:refs/remotes/origin/*'], 'refs/remotes/origin/topic/$$')
    ).toEqual(['refs/heads/topic/$$'])
  })
})
