import { describe, expect, it } from 'vitest'
import { normalizeGitLabLabelNames } from './gitlab-label-names'

describe('normalizeGitLabLabelNames', () => {
  it('keeps only names GitLab can filter by, once each', () => {
    expect(
      normalizeGitLabLabelNames([
        ' Bug ',
        'bug',
        'Bug',
        'a,b',
        'a\nb',
        7,
        '  ',
        'x'.repeat(256),
        'ok'
      ])
    ).toEqual(['Bug', 'bug', 'ok'])
  })
})
