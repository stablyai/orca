// @vitest-environment happy-dom

import { mocks } from './launch-agent-web-terminal.test-fixture'

import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { nonRefusedAgentLaunch } from '@/lib/agent-session/launch/new-tab/agent-tab-launch-outcome.test-fixture'
import { stubRuntimeEnvironmentBridge } from '@/runtime/rpc/testing/runtime-environment-bridge-fixture'

import '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'

import { describe, expect, it, vi } from 'vitest'

describe('launchAgentInNewTab paired web runtime', () => {
  it.each(['structured', 'legacy'] as const)(
    'fails visibly before %s creation when section trust capability lookup fails',
    async (route) => {
      mocks.actualOperation = true
      mocks.capability.mockImplementation(async (_environmentId, capability) => {
        if (capability === 'agent-session.trust-worktree.v1') {
          throw new Error('private capability transport failure')
        }
        return route === 'structured'
      })
      const dispatch = vi.fn(async (request: { method: string }) => ({
        ok: true,
        result:
          request.method === 'terminal.createAgentSession'
            ? { terminal: { tabId: 'host-tab', paneKey: 'host-tab:leaf' } }
            : { tab: { id: 'host-tab', leafId: 'leaf' } }
      }))
      stubRuntimeEnvironmentBridge({ call: dispatch })
      const { launchAgentInNewTab } =
        await import('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
      const result = nonRefusedAgentLaunch(
        launchAgentInNewTab({
          requestId: newAgentLaunchRequestId(),
          agent: 'claude',
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          activate: false,
          initialCwd: '/outside/section',
          trustWorktreeId: 'repo::/outside/section',
          prompt: 'Resolve conflicts'
        })
      )
      await expect(result?.terminalCompletion).resolves.toMatchObject({
        outcome: { status: 'failed' }
      })
      expect(dispatch).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledOnce()
    }
  )
})
