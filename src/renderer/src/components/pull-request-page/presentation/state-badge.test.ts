import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getSolidStateTone, getStateTone } from './state-badge'

function item(type: GitHubWorkItem['type'], state: GitHubWorkItem['state']): GitHubWorkItem {
  return { type, state } as GitHubWorkItem
}

describe('getStateTone', () => {
  it('uses purple/slate/rose/emerald for pull request states', () => {
    expect(getStateTone(item('pr', 'merged'))).toContain('purple')
    expect(getStateTone(item('pr', 'draft'))).toContain('slate')
    expect(getStateTone(item('pr', 'closed'))).toContain('rose')
    expect(getStateTone(item('pr', 'open'))).toContain('emerald')
  })

  it('uses rose for a closed issue and emerald otherwise', () => {
    expect(getStateTone(item('issue', 'closed'))).toContain('rose')
    expect(getStateTone(item('issue', 'open'))).toContain('emerald')
  })
})

describe('getSolidStateTone', () => {
  it('matches the outlined tone hues for every pull request state', () => {
    expect(getSolidStateTone(item('pr', 'merged'))).toContain('purple')
    expect(getSolidStateTone(item('pr', 'draft'))).toContain('slate')
    expect(getSolidStateTone(item('pr', 'closed'))).toContain('rose')
    expect(getSolidStateTone(item('pr', 'open'))).toContain('emerald')
  })

  it('uses rose for a closed issue and emerald otherwise', () => {
    expect(getSolidStateTone(item('issue', 'closed'))).toContain('rose')
    expect(getSolidStateTone(item('issue', 'open'))).toContain('emerald')
  })
})
