import { describe, expect, it, vi } from 'vitest'
import { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { prepareNativeChatCliFork } from '@/lib/agent-session/resume/cli-fork/native-chat-cli-fork-preparation'
import { notifyAiVaultSessionPreparationFailure } from '../../right-sidebar/ai-vault/session-actions/ai-vault-session-launch-feedback'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '../../right-sidebar/ai-vault/session-list/ai-vault-session-limit'
import { runNativeChatCliFork } from './native-chat-cli-fork-run'

const remoteHost = toRuntimeExecutionHostId('server')

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        'tab-worktree': [{ id: 'tab-id', contentType: 'agent-session', entityId: 'chat-id' }]
      }
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('./tab-session-history-switch', () => ({
  resolveNativeChatCliForkIdentity: () => ({ executionHostScope: remoteHost })
}))
vi.mock(
  import('@/runtime/agent-launch-settings/agent-launch-settings-transport'),
  async (importOriginal) => ({ ...(await importOriginal()), readHostAgentStartupSettings: vi.fn() })
)
vi.mock('@/lib/agent-session/resume/cli-fork/native-chat-cli-fork-preparation', () => ({
  prepareNativeChatCliFork: vi.fn()
}))
vi.mock('@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal', () => ({
  launchAiVaultSessionAndReveal: vi.fn()
}))
vi.mock('../../right-sidebar/ai-vault/session-actions/ai-vault-session-launch-feedback', () => ({
  notifyAiVaultSessionPreparationFailure: vi.fn()
}))

describe('runNativeChatCliFork', () => {
  it('refuses a paired handoff before the host makes a conversation copy', async () => {
    vi.mocked(readHostAgentStartupSettings).mockResolvedValue(null)

    await runNativeChatCliFork({
      subject: {
        kind: 'chat',
        workspaceId: 'target-worktree',
        sessionId: 'chat-id',
        request: {
          executionHostScope: remoteHost,
          scopePaths: [],
          sessionLimit: DEFAULT_AI_VAULT_SESSION_LIMIT
        }
      },
      tab: { id: 'tab-id', worktreeId: 'tab-worktree' },
      agent: 'opencode'
    })

    expect(readHostAgentStartupSettings).toHaveBeenCalledTimes(1)
    expect(prepareNativeChatCliFork).not.toHaveBeenCalled()
    expect(notifyAiVaultSessionPreparationFailure).toHaveBeenCalledWith(
      new Error('The conversation host is unavailable.'),
      'opencode',
      expect.any(Function)
    )
  })
})
