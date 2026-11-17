import { describe, expect, it } from 'vitest'
import {
  draftPatch,
  draftsEqual,
  emptyDraft,
  lineDiff,
  mergeEnvVarNames
} from './environment-draft'

describe('environment drafts', () => {
  it('treats URL spelling and blank branches as equal', () => {
    const a = {
      ...emptyDraft(['acme/web']),
      repos: [{ url: 'acme/web', defaultBranch: '' }]
    }
    const b = {
      ...emptyDraft(),
      repos: [{ url: 'https://github.com/acme/web.git', defaultBranch: null }]
    }
    expect(draftsEqual(a, b)).toBe(true)
  })

  it('patches only changed fields', () => {
    const base = emptyDraft(['acme/web'])
    const next = {
      ...base,
      installScript: 'pnpm i',
      machineSize: 'large' as const
    }
    expect(draftPatch(base, next)).toEqual({
      installScript: 'pnpm i',
      machineSize: 'large'
    })
  })

  it('merges env var names without dropping or duplicating', () => {
    expect(mergeEnvVarNames(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
  })
})

describe('lineDiff', () => {
  it('marks added and removed lines around common ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' }
    ])
    expect(lineDiff('', 'x')).toEqual([{ kind: 'add', text: 'x' }])
  })
})
