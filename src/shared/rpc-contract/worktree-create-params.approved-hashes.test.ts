import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from './worktree-create-params'

describe('WorktreeCreate approvedSetupHashes', () => {
  it('trims a long list instead of refusing the create', () => {
    const hashes = Array.from({ length: 70 }, (_, i) => `hash-${i}`)
    const parsed = WorktreeCreate.parse({ repo: 'repo', approvedSetupHashes: hashes })
    expect(parsed.approvedSetupHashes).toEqual(hashes.slice(0, 64))
  })

  it('drops malformed entries so they can never match', () => {
    const parsed = WorktreeCreate.parse({
      repo: 'repo',
      approvedSetupHashes: ['ok', 7, 'x'.repeat(129)]
    })
    expect(parsed.approvedSetupHashes).toEqual(['ok'])
  })
})
