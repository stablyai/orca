import { describe, expect, it } from 'vitest'
import { shortRefLabel } from './short-ref-label'

describe('shortRefLabel', () => {
  it('drops the refs/ namespace from qualified refs', () => {
    expect(shortRefLabel('refs/remotes/origin/master')).toBe('origin/master')
    expect(shortRefLabel('refs/heads/feature/x')).toBe('feature/x')
    expect(shortRefLabel('refs/tags/v1.2.0')).toBe('v1.2.0')
  })

  it('leaves bare names, commits and bare prefixes alone', () => {
    expect(shortRefLabel('origin/main')).toBe('origin/main')
    expect(shortRefLabel('3f2a9c1')).toBe('3f2a9c1')
    expect(shortRefLabel('refs/heads/')).toBe('refs/heads/')
  })
})
