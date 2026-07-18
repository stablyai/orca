import { describe, expect, it } from 'vitest'
import { requireSeededTestRepo } from './seeded-test-repo'

describe('seeded Electron E2E repo', () => {
  it('fails clearly when global setup did not publish a valid repo', () => {
    expect(() => requireSeededTestRepo('')).toThrow(/global setup did not publish a valid repo/)
  })
})
