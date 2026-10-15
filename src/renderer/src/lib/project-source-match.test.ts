import { describe, expect, it } from 'vitest'
import { pickBestProjectMatch } from './project-source-match'

const repo = (id: string, connectionId: string | null = null) => ({ id, connectionId })

describe('pickBestProjectMatch', () => {
  it('takes the highest score, never a zero', () => {
    const scored = [
      { repo: repo('weak'), score: 1 },
      { repo: repo('strong'), score: 2 },
      { repo: repo('none'), score: 0 }
    ]
    expect(pickBestProjectMatch(scored, 'none')).toBe('strong')
    expect(pickBestProjectMatch([{ repo: repo('none'), score: 0 }], 'none')).toBeNull()
  })

  it('breaks ties by the active project, then local over SSH, then order', () => {
    const scored = [
      { repo: repo('remote', 'ssh-1'), score: 1 },
      { repo: repo('first'), score: 1 },
      { repo: repo('second'), score: 1 }
    ]
    expect(pickBestProjectMatch(scored, null)).toBe('first')
    expect(pickBestProjectMatch(scored, 'remote')).toBe('remote')
  })
})
