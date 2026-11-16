import { describe, expect, it } from 'vitest'
import { WorktreeCreate } from './worktree-create-params'

describe('worktree.create accountPins', () => {
  const base = { repo: 'repo-1', name: 'feature' }

  it('accepts accounts for Claude and Codex', () => {
    const parsed = WorktreeCreate.parse({ ...base, accountPins: { claude: 'a', codex: 'b' } })
    expect(parsed.accountPins).toEqual({ claude: 'a', codex: 'b' })
  })

  it('refuses other agents and empty ids', () => {
    expect(WorktreeCreate.safeParse({ ...base, accountPins: { gemini: 'a' } }).success).toBe(false)
    expect(WorktreeCreate.safeParse({ ...base, accountPins: { claude: '' } }).success).toBe(false)
  })
})
