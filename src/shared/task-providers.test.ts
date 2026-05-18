import { describe, expect, it } from 'vitest'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider
} from './task-providers'

describe('task providers', () => {
  it('normalizes provider lists while preserving supported order', () => {
    expect(normalizeVisibleTaskProviders(['gitlab', 'unknown', 'gitlab', 'linear'])).toEqual([
      'gitlab',
      'linear'
    ])
  })

  it('falls back to all providers when none are visible', () => {
    expect(normalizeVisibleTaskProviders([])).toEqual(['github', 'gitlab', 'linear'])
  })

  it('resolves hidden preferred providers to the first visible provider', () => {
    expect(resolveVisibleTaskProvider('github', ['linear'])).toBe('linear')
  })

  it('filters runtime-unavailable providers without changing preference normalization', () => {
    expect(
      filterAvailableTaskProviders(['github', 'gitlab', 'linear'], {
        gitlabInstalled: false,
        linearConnected: true
      })
    ).toEqual(['github', 'linear'])
  })

  it('falls back to GitHub when every preferred provider is unavailable', () => {
    expect(
      filterAvailableTaskProviders(['gitlab', 'linear'], {
        gitlabInstalled: false,
        linearConnected: false
      })
    ).toEqual(['github'])
  })
})
