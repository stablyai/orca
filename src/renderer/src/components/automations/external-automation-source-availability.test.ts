import { describe, expect, it } from 'vitest'
import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import {
  getExternalAutomationActionDisabledMessage,
  getExternalAutomationSourceAvailability
} from './external-automation-source-availability'

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

describe('external automation source availability', () => {
  it('uses local repair copy for unavailable local sources', () => {
    expect(
      getExternalAutomationSourceAvailability({
        manager: manager(),
        providerLabel: 'Hermes',
        targetKindLabel: 'Local'
      })
    ).toMatchObject({
      statusLabel: 'Source unavailable',
      summary: 'Hermes source unavailable on local.',
      detail: 'Install or repair the local automation source, then retry to load jobs.',
      canConnectSsh: false,
      isConnecting: false
    })
  })

  it('asks users to connect disconnected SSH sources before checking jobs', () => {
    expect(
      getExternalAutomationSourceAvailability({
        manager: manager({
          id: 'hermes-devbox',
          targetLabel: 'Devbox',
          target: { type: 'ssh', connectionId: 'devbox' }
        }),
        providerLabel: 'Hermes',
        targetKindLabel: 'SSH host',
        sshStatus: 'disconnected'
      })
    ).toMatchObject({
      statusLabel: 'Connect SSH',
      summary: 'Hermes source unavailable until ssh host connects.',
      detail: 'Connect this SSH host to check for remote automation jobs.',
      canConnectSsh: true,
      isConnecting: false
    })
  })

  it('distinguishes connected SSH hosts with missing remote automation tooling', () => {
    expect(
      getExternalAutomationSourceAvailability({
        manager: manager({
          id: 'hermes-devbox',
          targetLabel: 'Devbox',
          target: { type: 'ssh', connectionId: 'devbox' }
        }),
        providerLabel: 'Hermes',
        targetKindLabel: 'SSH host',
        sshStatus: 'connected'
      })
    ).toMatchObject({
      statusLabel: 'Source unavailable',
      summary: 'Hermes source unavailable on this ssh host.',
      detail: 'Install or repair the remote automation source, then retry to load jobs.',
      canConnectSsh: true,
      isConnecting: false
    })
  })

  it('preserves manager errors while still reporting a connecting SSH state', () => {
    expect(
      getExternalAutomationSourceAvailability({
        manager: manager({
          error: 'Hermes binary was not found.',
          target: { type: 'ssh', connectionId: 'devbox' }
        }),
        providerLabel: 'Hermes',
        targetKindLabel: 'SSH host',
        sshStatus: 'connected',
        isConnectingOverride: true
      })
    ).toMatchObject({
      statusLabel: 'Connecting...',
      summary: 'Hermes binary was not found.',
      detail: 'Waiting for this SSH host before checking the remote automation source.',
      canConnectSsh: true,
      isConnecting: true
    })
  })

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
