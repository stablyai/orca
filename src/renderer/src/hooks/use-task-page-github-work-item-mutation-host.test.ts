import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { shouldSkipLocalViewerQualifiers } from './useTaskPageGitHubWorkItemMutation'

function sourceContext(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'github',
    projectId: 'project-1',
    hostId
  }
}

describe('TaskPage GitHub work-item mutation host handling', () => {
  it('uses the local viewer only for local task sources', () => {
    expect(shouldSkipLocalViewerQualifiers(sourceContext('local'))).toBe(false)
    expect(shouldSkipLocalViewerQualifiers(sourceContext('ssh:builder'))).toBe(true)
    expect(shouldSkipLocalViewerQualifiers(sourceContext('runtime:environment-1'))).toBe(true)
  })

  it('does not reuse the github.com viewer for a local enterprise host', () => {
    expect(
      shouldSkipLocalViewerQualifiers({
        ...sourceContext('local'),
        providerIdentity: {
          provider: 'github',
          owner: 'acme',
          repo: 'project',
          host: 'github.acme.test'
        }
      })
    ).toBe(true)
  })
})
