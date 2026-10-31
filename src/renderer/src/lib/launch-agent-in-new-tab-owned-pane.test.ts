import { expect, it, vi } from 'vitest'
import { store, mockCreateTab, mockSetActiveTabType } from './launch-agent-in-new-tab.test-fixture'

it.each([undefined, null, '--model gpt-5.5'])(
  'preserves owned terminal caller inputs for raw args %s across migrated-off, fresh and former-on CLI choices',
  async (agentArgs) => {
    const { launchAgentInNewTabWithOutcome } = await import('./launch-agent-in-new-tab')
    for (const nativeChatProviders of [{ codex: false }, undefined, { codex: true }]) {
      store.settings.nativeChatProviders = nativeChatProviders
      const beforeSurfaceOpen = vi.fn(() => true)
      const delivered = vi.fn()
      const outcome = launchAgentInNewTabWithOutcome({
        requestId: 'owned-caller',
        agent: 'codex',
        worktreeId: 'wt-1',
        groupId: 'requested-split',
        requestedSurface: 'terminal',
        prompt: 'fix checks',
        promptDelivery: 'submit-after-ready',
        agentArgs,
        sessionOptions: { model: 'gpt-5.5', permissionMode: 'ask' },
        launchSource: 'source_control_recovery',
        quickCommandLabel: 'Fix',
        pendingActivationSpawn: true,
        activate: false,
        beforeSurfaceOpen,
        onPromptDelivered: delivered
      })
      expect(outcome).toHaveProperty('surface', { kind: 'local-terminal', tabId: 'tab-1' })
      expect(mockCreateTab).toHaveBeenLastCalledWith(
        'wt-1',
        'requested-split',
        undefined,
        expect.objectContaining({
          id: 'tab-1',
          initialLeafId: 'tab-1',
          agentLaunchPane: { leafId: 'tab-1' },
          launchAgent: 'codex',
          quickCommandLabel: 'Fix',
          pendingActivationSpawn: true,
          activate: false,
          pendingStartup: {
            command: '',
            launchAgent: 'codex',
            agentLaunch: {
              launch: {
                agent: 'codex',
                target: { kind: 'existing', worktree: 'id:wt-1' },
                ...(agentArgs !== undefined ? { agentArgs } : {}),
                sessionOptions: { model: 'gpt-5.5', permissionMode: 'ask' },
                launchSource: 'source_control_recovery'
              },
              suppressStartupUpdatePrompt: true
            }
          }
        })
      )
      expect(beforeSurfaceOpen).toHaveBeenCalledExactlyOnceWith({ kind: 'local-terminal' })
      expect(mockSetActiveTabType).not.toHaveBeenCalled()
      if (!outcome || !('surface' in outcome) || !outcome.promptDeliveryResult) {
        throw new Error('missing delivery result')
      }
      await expect(outcome.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
      expect(delivered).toHaveBeenCalledOnce()
    }
  }
)
