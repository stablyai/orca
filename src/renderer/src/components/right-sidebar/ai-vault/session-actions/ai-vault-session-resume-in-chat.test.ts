import { expect, it } from 'vitest'
import { resolveAiVaultSessionResumeInChatEligibility } from './ai-vault-session-resume-in-chat'

it.each([
  { cwd: '/Users/me', available: true },
  // Session History lists a conversation saved in a sub-folder under the workspace, so Chat opens it.
  { cwd: '/Users/me/Downloads/projects/app', available: true },
  { cwd: '/Users/other/app', available: false }
])('offers Chat for a Pi conversation saved in %j of the workspace', ({ cwd, available }) => {
  expect(
    resolveAiVaultSessionResumeInChatEligibility({
      session: {
        agent: 'pi',
        cwd,
        filePath: '/Users/me/.pi/agent/sessions/x/2026-11-21_01a1ff56.jsonl',
        executionHostId: 'local',
        messageCount: 2,
        previewMessages: []
      },
      targetWorkspaceId: 'folder-home',
      targetWorkspacePath: '/Users/me',
      structuredRouteAvailable: true
    })
  ).toEqual(
    available
      ? { available: true, workspaceId: 'folder-home' }
      : { available: false, reason: 'workspace' }
  )
})
