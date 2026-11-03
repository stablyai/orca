import { describe, expect, it } from 'vitest'
import {
  queuedStartups,
  mockSetAgentStatus,
  mockPasteDraftWhenAgentReady,
  LEAF_ID,
  store,
  COMMAND_CODE_CLICK
} from './launch-agent-in-new-tab-test-fixture'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'

describe('launchAgentInNewTab', () => {
  it('falls back to post-ready draft paste when a Windows inline draft would be too large', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = launchAgentInNewTab({
      requestId: 'request-17',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft',
      launchPlatform: 'win32'
    })

    expect(result?.promptDeliveryResult).toBeDefined()
    expect(queuedStartups()).toContainEqual(
      expect.objectContaining({
        command: "claude '--dangerously-skip-permissions'"
      })
    )
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: prompt,
        agent: 'claude',
        submit: false,
        forcePaste: true
      })
    )
  })

  it('does not recreate SSH status when clear arrives before disconnect state', async () => {
    let finishDelivery: ((delivered: boolean) => void) | undefined
    mockPasteDraftWhenAgentReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDelivery = resolve
      })
    )
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      ...COMMAND_CODE_CLICK,
      prompt: 'pending prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: ptyId } }
    }
    store.ptyIdsByTabId = { 'tab-1': [ptyId] }

    // Disconnect clears status before the state event, while the old binding can still appear connected.
    store.transientClearedAgentStatusConnectionIds = { 'ssh-a': true }
    finishDelivery?.(true)
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    expect(mockSetAgentStatus).not.toHaveBeenCalled()
  })
})
