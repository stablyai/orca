import { describe, expect, it } from 'vitest'
import {
  PLUGIN_SIDECAR_PAYLOAD_MAX_BYTES,
  buildSidecarPlacement,
  sidecarPublishParamsSchema
} from './plugin-sidecar-contract'

describe('plugin sidecar contract', () => {
  it('requires payload on set and forbids it on clear', () => {
    expect(sidecarPublishParamsSchema.safeParse({ channel: 'presence', op: 'set' }).success).toBe(
      false
    )
    expect(
      sidecarPublishParamsSchema.safeParse({ channel: 'presence', op: 'clear', payload: { a: 1 } })
        .success
    ).toBe(false)
    expect(
      sidecarPublishParamsSchema.safeParse({
        channel: 'presence',
        op: 'set',
        payload: { details: 'Working in Orca' }
      }).success
    ).toBe(true)
    expect(sidecarPublishParamsSchema.safeParse({ channel: 'generic', op: 'clear' }).success).toBe(
      true
    )
  })

  it('rejects a payload whose JSON exceeds the byte cap', () => {
    expect(
      sidecarPublishParamsSchema.safeParse({
        channel: 'generic',
        op: 'set',
        payload: 'x'.repeat(PLUGIN_SIDECAR_PAYLOAD_MAX_BYTES + 1)
      }).success
    ).toBe(false)
  })

  it('reports host-only plugin process and Discord-on-UI-machine IPC', () => {
    expect(buildSidecarPlacement(null)).toMatchObject({
      pluginProcess: 'runtime-host',
      discordIpcMustRun: 'machine-with-discord',
      hostForwards: 'sidecar-frames',
      hostDoesNotForward: ['discord-ipc-bytes', 'companion-http'],
      mailboxAvailable: true,
      companionStillValid: true,
      lastPublishedAt: null
    })
    expect(buildSidecarPlacement(12).lastPublishedAt).toBe(12)
  })
})
