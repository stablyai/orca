import { describe, expect, it } from 'vitest'
import {
  getWorkspaceNotificationOrigin,
  allowsWorkspaceAgentNotification
} from './workspace-notification-policy'
import type { AutomationWorkspaceProvenance } from './worktree/types'

const automationProvenance: AutomationWorkspaceProvenance = {
  kind: 'created-by-automation',
  automationId: 'automation',
  automationNameSnapshot: 'Daily',
  automationRunId: 'run',
  automationRunTitleSnapshot: 'Daily run',
  createdAt: 1,
  executionTargetType: 'local',
  executionTargetId: 'repo',
  projectId: 'project'
}

describe('workspace notification provenance', () => {
  it('recognizes CLI metadata and the legacy creation source without requiring a dispatch', () => {
    expect(
      getWorkspaceNotificationOrigin({ cliProvenance: { kind: 'created-by-cli', createdAt: 1 } })
    ).toBe('cli')
    expect(getWorkspaceNotificationOrigin({ orcaCreationSource: 'cli' })).toBe('cli')
    expect(getWorkspaceNotificationOrigin(undefined)).toBe('other')
    expect(getWorkspaceNotificationOrigin({ orcaCreationSource: 'ssh' })).toBe('other')
  })

  it('uses automation provenance before incidental CLI creation metadata', () => {
    expect(getWorkspaceNotificationOrigin({ automationProvenance })).toBe('automation')
    expect(
      getWorkspaceNotificationOrigin({
        automationProvenance,
        orcaCreationSource: 'cli',
        cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
      })
    ).toBe('automation')
  })

  it.each([
    ['cli', false, true, false],
    ['cli', true, false, true],
    ['automation', false, true, true],
    ['automation', true, false, false],
    ['other', false, false, true]
  ] as const)(
    'applies independent settings for %s (%s, %s)',
    (origin, cli, automation, allowed) => {
      expect(
        allowsWorkspaceAgentNotification(
          {
            cliWorktreeTaskComplete: cli,
            automationWorktreeTaskComplete: automation
          },
          origin
        )
      ).toBe(allowed)
      expect(allowsWorkspaceAgentNotification({}, origin)).toBe(true)
    }
  )
})
