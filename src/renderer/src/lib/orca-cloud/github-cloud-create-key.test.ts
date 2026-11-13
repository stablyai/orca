import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetGitHubCreateKey,
  githubCreateIdempotencyKey,
  noteGitHubCreateOutcome,
  resetGitHubCreateKeysForTest
} from './github-cloud-create-key'

beforeEach(() => resetGitHubCreateKeysForTest())

describe('GitHub-only create Idempotency-Key (GH-CREATE-SHEET)', () => {
  it('a Retry after a lost answer resends the same key, so it gets the same sandbox back', () => {
    const first = githubCreateIdempotencyKey('c1')
    noteGitHubCreateOutcome('c1', true)
    expect(githubCreateIdempotencyKey('c1')).toBe(first)
    noteGitHubCreateOutcome('c1', true)
    expect(githubCreateIdempotencyKey('c1')).toBe(first)
  })

  it('a Retry after an answered failure is a new attempt with a new key', () => {
    const first = githubCreateIdempotencyKey('c1')
    noteGitHubCreateOutcome('c1', false)
    const second = githubCreateIdempotencyKey('c1')
    expect(second).toBe(`${first}:retry-1`)
    // Its answer is then lost: the next Retry resends that second key.
    noteGitHubCreateOutcome('c1', true)
    expect(githubCreateIdempotencyKey('c1')).toBe(second)
  })

  it('keys are per creation and within the server format', () => {
    const a = githubCreateIdempotencyKey('c1')
    const b = githubCreateIdempotencyKey('c2')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/)
    forgetGitHubCreateKey('c1')
    expect(githubCreateIdempotencyKey('c1')).toBe(a)
  })
})
