import { describe, expect, it } from 'vitest'
import {
  buildLinearWorkspaceSource,
  buildWorkspaceSourceSelection,
  getWorkspaceSourceName,
  getWorkspaceSourceProvider,
  shouldApplyWorkspaceSourceAutoName,
  shouldPreserveWorkspaceSourceOnRepoChange
} from './workspace-source'

describe('workspace source policy', () => {
  const linear = buildLinearWorkspaceSource({
    identifier: 'ENG-42',
    title: 'Ship mobile parity',
    url: 'https://linear.app/acme/issue/ENG-42/ship-mobile-parity',
    workspaceId: 'workspace-1'
  })

  it('builds one Linear identity for desktop and mobile create flows', () => {
    expect(linear).toMatchObject({
      provider: 'linear',
      number: 0,
      linearIdentifier: 'ENG-42',
      linearWorkspaceId: 'workspace-1',
      linearOrganizationUrlKey: 'acme'
    })
    expect(getWorkspaceSourceName(linear)).toEqual({
      seedName: 'eng-42-ship-mobile-parity',
      displayName: 'ENG-42 Ship mobile parity'
    })
  })

  it('preserves global work-item sources across repo changes', () => {
    expect(shouldPreserveWorkspaceSourceOnRepoChange(linear)).toBe(true)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'github',
        type: 'issue',
        number: 1,
        title: 'Repo scoped',
        url: 'https://github.com/o/r/issues/1'
      })
    ).toBe(false)
  })

  it('shares provider inference, selection labels, and auto-name gates', () => {
    const legacyGitLab = {
      type: 'issue' as const,
      number: 7,
      title: 'Self hosted',
      url: 'https://gitlab.example.com/g/p/-/work_items/7'
    }
    expect(getWorkspaceSourceProvider(legacyGitLab)).toBe('gitlab')
    expect(buildWorkspaceSourceSelection({ linkedWorkItem: legacyGitLab })).toMatchObject({
      kind: 'gitlab-issue',
      label: '#7 Self hosted'
    })
    expect(shouldApplyWorkspaceSourceAutoName({ currentName: '#42', lastAutoName: 'old' })).toBe(
      true
    )
    expect(
      shouldApplyWorkspaceSourceAutoName({ currentName: 'my workspace', lastAutoName: 'old' })
    ).toBe(false)
  })
})
