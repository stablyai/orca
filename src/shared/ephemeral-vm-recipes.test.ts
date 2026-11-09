import { describe, expect, it } from 'vitest'
import { encodePairingOffer } from './remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from './remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  redactEphemeralVmRecipeResultForDiagnostics
} from './ephemeral-vm-recipe-diagnostics'

function makePairingCode(endpoint = 'wss://sandbox.example.com'): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

describe('parseEphemeralVmRecipeResult', () => {
  it('warns for public insecure websocket endpoints', () => {
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('ws://sandbox.example.com:6767'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([
      expect.objectContaining({
        id: 'recipe.result.endpoint.public_ws',
        message: expect.stringContaining('ws://sandbox.example.com:6767')
      })
    ])
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('ws://127.0.0.1:6767'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([])
    expect(
      getEphemeralVmRecipeResultWarnings({
        schemaVersion: 1,
        pairingCode: makePairingCode('wss://sandbox.example.com'),
        projectRoot: '/workspace/repo'
      })
    ).toEqual([])
  })

  it('redacts pairing material and secret-looking fields in diagnostics', () => {
    const pairingCode = makePairingCode()

    expect(
      redactEphemeralVmRecipeDiagnosticText(
        JSON.stringify({
          pairingCode,
          token: 'provider-token',
          identityFile: '/secret/key',
          proxyCommand: 'provider token',
          ok: true
        })
      )
    ).toBe(
      '{"pairingCode":"[redacted]","token":"[redacted]","identityFile":"[redacted]","proxyCommand":"[redacted]","ok":true}'
    )
    expect(
      redactEphemeralVmRecipeDiagnosticText(
        'clone https://recipe-user:recipe-token@git.example.com/team/repo.git'
      )
    ).toBe('clone https://git.example.com/team/repo.git')
    expect(
      redactEphemeralVmRecipeResultForDiagnostics({
        schemaVersion: 1,
        pairingCode,
        projectRoot: '/workspace/repo',
        userData: {
          providerResourceId: 'sandbox-123',
          accessToken: 'provider-token',
          nested: { apiKey: 'key', region: 'us-east-1' }
        }
      })
    ).toEqual({
      schemaVersion: 1,
      pairingCode: 'orca://pair?code=[redacted]',
      projectRoot: '/workspace/repo',
      userData: {
        providerResourceId: 'sandbox-123',
        accessToken: '[redacted]',
        nested: { apiKey: '[redacted]', region: 'us-east-1' }
      }
    })
    expect(
      redactEphemeralVmRecipeResultForDiagnostics({
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: {
            label: 'Sandbox',
            host: 'sandbox.example.com',
            port: 22,
            username: 'root',
            identityFile: '/secret/key',
            identityAgent: '/secret/agent.sock',
            proxyCommand: 'provider ssh-proxy sandbox-123'
          }
        }
      })
    ).toEqual({
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: {
          label: 'Sandbox',
          host: 'sandbox.example.com',
          port: 22,
          username: 'root',
          identityFile: '[redacted-path]',
          identityAgent: '[redacted-path]',
          proxyCommand: '[redacted]'
        }
      }
    })
  })
})
