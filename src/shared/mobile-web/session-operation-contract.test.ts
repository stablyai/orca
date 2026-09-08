import { describe, expect, it } from 'vitest'
import {
  MobileWebSessionAgentOptionsResultSchema,
  MobileWebSessionCapabilitiesPayloadSchema,
  MobileWebSessionCapabilitiesResultSchema,
  MobileWebSessionHostGatesPayloadSchema,
  MobileWebSessionHostGatesResultSchema,
  MobileWebSessionCreateAgentPayloadSchema
} from './session-operation-contract'

describe('mobile web session operation contract', () => {
  it('keeps the runtime-capability request and boolean projection strict', () => {
    expect(MobileWebSessionCapabilitiesPayloadSchema.safeParse({}).success).toBe(true)
    expect(
      MobileWebSessionCapabilitiesPayloadSchema.safeParse({ capabilities: ['secret.v1'] }).success
    ).toBe(false)

    const projection = {
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: false,
      terminalQueryReplyInputSupported: true
    }
    expect(MobileWebSessionCapabilitiesResultSchema.parse(projection)).toEqual(projection)
    expect(
      MobileWebSessionCapabilitiesResultSchema.safeParse({
        ...projection,
        capabilities: ['secret.v1']
      }).success
    ).toBe(false)
  })

  it('gates the bounded host projection behind a distinct strict payload', () => {
    expect(
      MobileWebSessionCapabilitiesPayloadSchema.safeParse({ includeHostGates: true }).success
    ).toBe(false)
    expect(MobileWebSessionHostGatesPayloadSchema.parse({ includeHostGates: true })).toEqual({
      includeHostGates: true
    })
    expect(MobileWebSessionHostGatesPayloadSchema.safeParse({}).success).toBe(false)

    const projection = {
      hostCapabilities: ['aiVault.v1', 'terminal.quick-commands.v1'],
      floatingWorkspaceEnabled: true
    }
    expect(MobileWebSessionHostGatesResultSchema.parse(projection)).toEqual(projection)
    for (const leaked of ['deviceToken', 'pairedDeviceId', 'protocolVersion', 'rawStatus']) {
      expect(
        MobileWebSessionHostGatesResultSchema.safeParse({ ...projection, [leaked]: 'secret' })
          .success
      ).toBe(false)
    }
    expect(
      MobileWebSessionHostGatesResultSchema.safeParse({
        ...projection,
        hostCapabilities: ['x'.repeat(121)]
      }).success
    ).toBe(false)
  })

  it('accepts only known agents in bounded option and create payloads', () => {
    expect(
      MobileWebSessionAgentOptionsResultSchema.parse({
        agents: ['codex', 'claude']
      })
    ).toEqual({ agents: ['codex', 'claude'] })
    expect(
      MobileWebSessionAgentOptionsResultSchema.safeParse({
        agents: ['not an agent']
      }).success
    ).toBe(false)
    expect(
      MobileWebSessionCreateAgentPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        agent: 'codex'
      }).success
    ).toBe(true)
    expect(
      MobileWebSessionCreateAgentPayloadSchema.safeParse({
        workspaceId: 'workspace-1',
        agent: 'not an agent'
      }).success
    ).toBe(false)
  })
})
