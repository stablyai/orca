import { describe, expect, it } from 'vitest'
import {
  countWholeGitStatusPills,
  getMostSevereGitStatusTone
} from './workspace-cleanup-git-status-pills'

describe('countWholeGitStatusPills', () => {
  it('shows every pill when they all fit', () => {
    expect(countWholeGitStatusPills([50, 50, 50], 200, 28, 6)).toBe(3)
  })

  it('keeps the leading pills whole and collapses the rest when they do not all fit', () => {
    expect(countWholeGitStatusPills([60, 60, 60], 140, 28, 6)).toBe(1)
    expect(countWholeGitStatusPills([60, 60, 60], 180, 28, 6)).toBe(2)
  })

  it('keeps the blocking first pill even when it cannot fit beside the +N chip', () => {
    expect(countWholeGitStatusPills([200, 60], 150, 28, 6)).toBe(1)
  })

  it('collapses everything into the +N chip when even a truncated first pill would be too narrow', () => {
    expect(countWholeGitStatusPills([45], 30, 20, 6)).toBe(0)
    expect(countWholeGitStatusPills([200, 60], 41, 28, 6)).toBe(1)
  })
})

describe('getMostSevereGitStatusTone', () => {
  it('flags folded warnings and stays neutral for harmless ones', () => {
    expect(getMostSevereGitStatusTone([{ tone: 'ready' }, { tone: 'review' }])).toBe('review')
    expect(getMostSevereGitStatusTone([{ tone: 'review' }, { tone: 'destructive' }])).toBe(
      'destructive'
    )
    expect(getMostSevereGitStatusTone([{ tone: 'ready' }, { tone: 'neutral' }])).toBeNull()
  })
})
