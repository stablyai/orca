import { describe, expect, it } from 'vitest'
import {
  herdrPaneRef,
  herdrExternalRefKey,
  herdrSessionNameForProject,
  herdrSplitDirection,
  herdrTabRef,
  herdrWorktreeRef
} from './herdr-session-identity'

describe('Herdr session identity', () => {
  it('uses the persisted project session name when linked explicitly', () => {
    expect(
      herdrSessionNameForProject({ id: 'Project 1', herdrSessionName: ' shared-session ' })
    ).toBe('shared-session')
  })

  it('derives stable resource references from Orca identities', () => {
    expect(herdrSessionNameForProject({ id: 'Project 1' })).toBe('orca-project-1')
    expect(
      herdrWorktreeRef('project-1', { id: 'repo::/worktree', instanceId: 'instance-1' })
    ).toEqual({ owner: 'orca', id: 'project-1:worktree:instance-1' })
    expect(herdrTabRef('project-1', 'tab-1')).toEqual({
      owner: 'orca',
      id: 'project-1:tab:tab-1'
    })
    expect(herdrPaneRef('project-1', 'leaf-1')).toEqual({
      owner: 'orca',
      id: 'project-1:pane:leaf-1'
    })
  })

  it('translates Orca split axes exactly', () => {
    expect(herdrSplitDirection('vertical')).toBe('right')
    expect(herdrSplitDirection('horizontal')).toBe('down')
  })

  it('keeps identical external IDs from different owners distinct', () => {
    expect(herdrExternalRefKey({ owner: 'orca', id: 'pane-1' })).not.toBe(
      herdrExternalRefKey({ owner: 'another-client', id: 'pane-1' })
    )
  })
})
