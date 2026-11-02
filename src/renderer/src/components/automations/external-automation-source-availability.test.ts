import { describe, expect, it } from 'vitest'
import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import { getExternalAutomationActionDisabledMessage } from './external-automation-source-availability'

function manager(overrides: Partial<ExternalAutomationManager> = {}): ExternalAutomationManager {
  return {
    id: 'openclaw-local',
    provider: 'openclaw',
    label: 'OpenClaw',
    targetLabel: 'Local Mac',
    target: { type: 'local' },
    status: 'unavailable',
    error: null,
    canManage: false,
    jobs: [],
    ...overrides
  }
}

describe('external automation action availability', () => {
  it('explains disabled local automation actions when the source tool is missing', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          error: 'OpenClaw jobs were found, but the openclaw CLI is not on PATH.'
        })
      })
    ).toBe('OpenClaw jobs were found, but the openclaw CLI is not on PATH.')
  })

  it('explains disabled SSH automation actions before the host is connected', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'SSH target is not connected.'
        }),
        providerLabel: 'OpenClaw',
        sshStatus: 'disconnected'
      })
    ).toBe('Connect this SSH host before managing OpenClaw automations.')
  })

  it('explains disabled SSH automation actions while the host is connecting', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'SSH target is not connected.'
        }),
        sshStatus: 'deploying-relay'
      })
    ).toBe('Wait for this SSH host to finish connecting.')
  })

  it('explains disabled SSH automation actions when the remote source tool is missing', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'OpenClaw CLI is not on the remote PATH.'
        }),
        sshStatus: 'connected'
      })
    ).toBe('OpenClaw CLI is not on the remote PATH.')
  })

  it('keeps concrete remote source errors when SSH status is unavailable to the caller', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'OpenClaw CLI is not on the remote PATH.'
        })
      })
    ).toBe('OpenClaw CLI is not on the remote PATH.')
  })

  it('explains disabled actions while another automation action is running', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({ canManage: true }),
        actionInProgress: true
      })
    ).toBe('Another automation action is still running.')
  })
})
