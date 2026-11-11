import { expect, it } from 'vitest'
import { buildAgentSessionContinuationPrompt } from '@/lib/agent-session/context/agent-session-continuation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { prepareAiVaultSessionContinuation } from './ai-vault-session-continuation'

it('continues a Hermes SQLite session with its preview instead of a synthetic transcript path', () => {
  const { source } = prepareAiVaultSessionContinuation({
    session: {
      id: 'hermes:one',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      agent: 'hermes',
      sessionId: 'one',
      title: 'Hermes history',
      cwd: '/project',
      branch: null,
      model: null,
      filePath: '/fixtures/state.db#one',
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-06-01T10:00:00.000Z',
      messageCount: 1,
      totalTokens: 0,
      previewMessages: [{ role: 'user', text: 'Only in the preview', timestamp: null }],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: 'hermes --resume one',
      subagent: null
    },
    targetWorktreeId: 'worktree',
    targetWorkspacePath: '/project'
  })

  const prompt = buildAgentSessionContinuationPrompt(source, 'focused')
  expect(prompt).toContain('Only in the preview')
  expect(prompt).not.toContain('/fixtures/state.db#one')
  expect(buildAgentSessionContinuationPrompt(source, 'full')).toBeNull()
})
