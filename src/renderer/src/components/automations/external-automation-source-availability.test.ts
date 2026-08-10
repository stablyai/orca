import { describe, expect, it } from 'vitest'
import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import { getExternalAutomationActionDisabledMessage } from './external-automation-source-availability'

function manager(overrides: Partial<ExternalAutomationManager> = {}): ExternalAutomationManager {
  return {
    id: 'hermes-local',
    provider: 'hermes',
    label: 'Hermes',
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
        manager: manager({ error: 'Hermes jobs were found, but the hermes CLI is not on PATH.' })
      })
    ).toBe('Hermes jobs were found, but the hermes CLI is not on PATH.')
  })

  it('explains disabled SSH automation actions before the host is connected', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'SSH target is not connected.'
        }),
        providerLabel: 'Hermes',
        targetKindLabel: 'SSH host',
        sshStatus: 'disconnected'
      })
    ).toBe('Connect this ssh host before managing Hermes automations.')
  })

  it('explains disabled SSH automation actions while the host is connecting', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'SSH target is not connected.'
        }),
        targetKindLabel: 'SSH host',
        sshStatus: 'deploying-relay'
      })
    ).toBe('Wait for this ssh host to finish connecting.')
  })

  it('explains disabled SSH automation actions when the remote source tool is missing', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'Hermes CLI is not on the remote PATH.'
        }),
        sshStatus: 'connected'
      })
    ).toBe('Hermes CLI is not on the remote PATH.')
  })

  it('keeps concrete remote source errors when SSH status is unavailable to the caller', () => {
    expect(
      getExternalAutomationActionDisabledMessage({
        manager: manager({
          target: { type: 'ssh', connectionId: 'devbox' },
          error: 'Hermes CLI is not on the remote PATH.'
        })
      })
    ).toBe('Hermes CLI is not on the remote PATH.')
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
