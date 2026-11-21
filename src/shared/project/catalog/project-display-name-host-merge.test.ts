import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host/execution-host'
import type { Project } from '../project-types'
import {
  mergePreviousProjectMetadata,
  retainExistingProjectDisplayName
} from './project-compatibility-merge'

function project(displayName: string): Project {
  return {
    id: 'github:example/backend',
    displayName,
    badgeColor: 'blue',
    sourceRepoIds: ['local-repo'],
    createdAt: 1,
    updatedAt: 2
  }
}

describe('project display name across hosts', () => {
  it('keeps the existing name when another host reports its folder name', () => {
    const merged = mergePreviousProjectMetadata(
      project('backend'),
      project('VentrueProjects'),
      new Map(),
      'runtime:desktop-home'
    )

    expect(merged.displayName).toBe('backend')
  })

  it('keeps the stored name when a host setup result arrives with the folder name', () => {
    expect(
      retainExistingProjectDisplayName(project('backend'), project('VentrueProjects')).displayName
    ).toBe('backend')
  })

  it('accepts a new name from the local host catalog', () => {
    const merged = mergePreviousProjectMetadata(
      project('backend'),
      project('api'),
      new Map(),
      LOCAL_EXECUTION_HOST_ID
    )

    expect(merged.displayName).toBe('api')
  })
})
