import { describe, expect, it } from 'vitest'
import { describeRuntimeCompatBlock, type RuntimeCompatVerdict } from './protocol-compat'
import {
  buildRuntimeUpdateGuide,
  type RuntimeUpdateGuide,
  type RuntimeUpdateGuideInput
} from './runtime-update-guide'

const SERVER_TOO_OLD: RuntimeCompatVerdict = {
  kind: 'blocked',
  reason: 'server-too-old',
  clientProtocolVersion: 6,
  serverProtocolVersion: 2,
  requiredServerProtocolVersion: 5
}

const CLIENT_TOO_OLD: RuntimeCompatVerdict = {
  kind: 'blocked',
  reason: 'client-too-old',
  clientProtocolVersion: 1,
  serverProtocolVersion: 4,
  requiredClientProtocolVersion: 4
}

function serverGuide(
  overrides: Omit<RuntimeUpdateGuideInput, 'verdict'>
): Extract<RuntimeUpdateGuide, { direction: 'server-too-old' }> {
  const guide = buildRuntimeUpdateGuide({ verdict: SERVER_TOO_OLD, ...overrides })
  if (!guide || guide.direction !== 'server-too-old') {
    throw new Error('expected a server-too-old guide')
  }
  return guide
}

function commandTexts(
  guide: Extract<RuntimeUpdateGuide, { direction: 'server-too-old' }>
): string[] {
  return guide.steps.filter((step) => step.kind === 'command').map((step) => step.text)
}

function proseTexts(guide: Extract<RuntimeUpdateGuide, { direction: 'server-too-old' }>): string[] {
  return guide.steps.filter((step) => step.kind === 'prose').map((step) => step.text)
}

const APPIMAGE_X64_DEFAULT_SWAP = [
  'sudo curl -fL https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage \\',
  '  -o /opt/orca/orca-linux.AppImage.new',
  'sudo chmod +x /opt/orca/orca-linux.AppImage.new',
  'sudo mv /opt/orca/orca-linux.AppImage.new /opt/orca/orca-linux.AppImage'
].join('\n')

describe('buildRuntimeUpdateGuide verdict branching', () => {
  it('returns null when the verdict is not blocked', () => {
    expect(
      buildRuntimeUpdateGuide({
        verdict: { kind: 'ok', clientProtocolVersion: 6, serverProtocolVersion: 6 }
      })
    ).toBeNull()
  })

  it('routes client-too-old to the local updater with no server commands', () => {
    const guide = buildRuntimeUpdateGuide({ verdict: CLIENT_TOO_OLD })
    expect(guide).toEqual({
      direction: 'client-too-old',
      localUpdate: true,
      title: 'Update this Orca client',
      message: describeRuntimeCompatBlock(CLIENT_TOO_OLD)
    })
    // No command block, no privileged command anywhere in the rendered guide.
    expect(JSON.stringify(guide)).not.toContain('sudo')
  })

  it('surfaces running and required protocol versions for server-too-old', () => {
    const guide = serverGuide({ installKind: 'unknown' })
    expect(guide.primary).toBe('This Orca server needs an update before this client can use it.')
    expect(guide.protocol).toEqual({ running: 2, required: 5 })
  })
})

describe('Linux AppImage guide', () => {
  it('x64 + systemd renders the exact swap and restart commands', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-appimage',
      restartKind: 'systemd',
      hostArch: 'x64'
    })
    expect(guide.detectedLine).toBe('Detected: Linux AppImage, systemd service.')
    expect(commandTexts(guide)).toEqual([
      APPIMAGE_X64_DEFAULT_SWAP,
      'sudo systemctl restart orca-serve.service'
    ])
  })

  it('arm64 uses the arm64 asset, custom install path, and custom service', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-appimage',
      restartKind: 'systemd',
      hostArch: 'arm64',
      installPath: '/srv/orca/orca.AppImage',
      serviceName: 'orca-headless.service'
    })
    expect(commandTexts(guide)).toEqual([
      [
        'sudo curl -fL https://github.com/stablyai/orca/releases/latest/download/orca-linux-arm64.AppImage \\',
        '  -o /srv/orca/orca.AppImage.new',
        'sudo chmod +x /srv/orca/orca.AppImage.new',
        'sudo mv /srv/orca/orca.AppImage.new /srv/orca/orca.AppImage'
      ].join('\n'),
      'sudo systemctl restart orca-headless.service'
    ])
  })

  it('shows the x64 command plus an arm64 note when arch is unknown', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-appimage',
      restartKind: 'systemd'
    })
    expect(commandTexts(guide)[0]).toBe(APPIMAGE_X64_DEFAULT_SWAP)
    expect(proseTexts(guide).some((text) => text.includes('orca-linux-arm64.AppImage'))).toBe(true)
  })

  it('foreground-serve gives incomplete-example prose and no restart command', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-appimage',
      restartKind: 'foreground-serve'
    })
    expect(guide.detectedLine).toBe('Detected: Linux AppImage, foreground orca serve.')
    // Only the swap command block; the restart is prose framed as incomplete.
    expect(commandTexts(guide)).toEqual([APPIMAGE_X64_DEFAULT_SWAP])
    const foreground = proseTexts(guide).find((text) => text.includes('Ctrl+C'))
    expect(foreground).toContain(
      'LIBGL_ALWAYS_SOFTWARE=1 /opt/orca/orca-linux.AppImage serve --port 6768'
    )
    expect(foreground).toContain('incomplete')
  })

  it('uses the paired-endpoint port hint in the foreground example', () => {
    const guide = serverGuide({
      installKind: 'linux-appimage',
      restartKind: 'foreground-serve',
      port: 7000
    })
    expect(proseTexts(guide).some((text) => text.includes('--port 7000'))).toBe(true)
  })

  it('covers both restart shapes when restartKind is unknown', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-appimage'
    })
    expect(guide.detectedLine).toBe('Detected: Linux AppImage.')
    const ambiguous = proseTexts(guide).find((text) => text.includes('systemctl restart'))
    expect(ambiguous).toContain('sudo systemctl restart orca-serve.service')
    expect(ambiguous).toContain('orca serve')
  })
})

describe('Debian / Ubuntu package guide', () => {
  it('prepends curl and installs the exact asset filename when a URL is supplied', () => {
    const guide = serverGuide({
      hostPlatform: 'linux',
      installKind: 'linux-deb',
      restartKind: 'systemd',
      assetUrl: 'https://github.com/stablyai/orca/releases/download/v1.2.3/orca-ide_1.2.3_amd64.deb'
    })
    expect(commandTexts(guide)).toEqual([
      'curl -fLO https://github.com/stablyai/orca/releases/download/v1.2.3/orca-ide_1.2.3_amd64.deb\nsudo apt install ./orca-ide_1.2.3_amd64.deb',
      'sudo systemctl restart orca-serve.service'
    ])
  })

  it('never invents a versioned filename without an asset URL', () => {
    const guide = serverGuide({ hostPlatform: 'linux', installKind: 'linux-deb' })
    expect(commandTexts(guide)).toContain('sudo apt install ./<downloaded-file>.deb')
    expect(JSON.stringify(guide)).not.toMatch(/orca-ide_[^<]*\.deb/)
    expect(guide.detectedLine).toBe('Detected: Debian/Ubuntu package.')
  })
})

describe('RPM package guide', () => {
  it('prepends curl and installs the exact rpm when a URL is supplied', () => {
    const guide = serverGuide({
      installKind: 'linux-rpm',
      restartKind: 'systemd',
      assetUrl:
        'https://github.com/stablyai/orca/releases/download/v1.2.3/orca-ide-1.2.3.aarch64.rpm'
    })
    expect(commandTexts(guide)).toEqual([
      'curl -fLO https://github.com/stablyai/orca/releases/download/v1.2.3/orca-ide-1.2.3.aarch64.rpm\nsudo dnf install ./orca-ide-1.2.3.aarch64.rpm',
      'sudo systemctl restart orca-serve.service'
    ])
  })

  it('never invents a versioned filename without an asset URL', () => {
    const guide = serverGuide({ installKind: 'linux-rpm' })
    expect(commandTexts(guide)).toContain('sudo dnf install ./<downloaded-file>.rpm')
    expect(JSON.stringify(guide)).not.toMatch(/orca-ide-[^<]*\.rpm/)
  })
})

describe('macOS guide', () => {
  it('offers in-app / dmg / homebrew paths with no privileged commands', () => {
    const guide = serverGuide({
      hostPlatform: 'darwin',
      installKind: 'mac-app',
      hostArch: 'arm64'
    })
    expect(guide.detectedLine).toBe('Detected: macOS app.')
    expect(proseTexts(guide).some((text) => text.includes('orca-macos-arm64.dmg'))).toBe(true)
    expect(commandTexts(guide)).toEqual([
      'brew update && brew upgrade --cask stablyai/orca/orca --greedy'
    ])
    expect(JSON.stringify(guide)).not.toContain('sudo')
  })

  it('mac-homebrew maps to the same macOS guide', () => {
    const guide = serverGuide({ hostPlatform: 'darwin', installKind: 'mac-homebrew' })
    expect(guide.detectedLine).toBe('Detected: macOS app.')
    expect(proseTexts(guide).some((text) => text.includes('orca-macos-<arch>.dmg'))).toBe(true)
  })
})

describe('Windows guide', () => {
  it('links the setup installer and avoids privileged commands', () => {
    const guide = serverGuide({ hostPlatform: 'win32', installKind: 'windows-installer' })
    expect(guide.detectedLine).toBe('Detected: Windows installer.')
    expect(
      proseTexts(guide).some((text) =>
        text.includes(
          'https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe'
        )
      )
    ).toBe(true)
    expect(JSON.stringify(guide)).not.toContain('sudo')
  })
})

describe('source build guide', () => {
  it('links the repo README', () => {
    const guide = serverGuide({ installKind: 'source' })
    expect(guide.detectedLine).toBe('Detected: source build.')
    expect(guide.links).toContainEqual({
      label: 'Orca repository README',
      url: 'https://github.com/stablyai/orca/blob/main/README.md'
    })
  })
})

describe('unknown / cold-start guide', () => {
  it('all fields absent still produces a useful unknown-install guide', () => {
    const guide = serverGuide({})
    expect(guide.detectedLine).toBeNull()
    expect(proseTexts(guide)).toContain(
      'Update Orca on the server machine, restart the server, and click "Check again".'
    )
    expect(guide.links).toEqual([
      { label: 'Orca releases', url: 'https://github.com/stablyai/orca/releases' },
      {
        label: 'Headless Linux server guide',
        url: 'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md'
      }
    ])
  })

  it('shows platform, version, and an AppImage hint when linux but install kind unknown', () => {
    const guide = serverGuide({ hostPlatform: 'linux', currentVersion: '3.1.0' })
    expect(proseTexts(guide)).toContain('The server is running on Linux (version 3.1.0).')
    expect(proseTexts(guide).some((text) => text.includes('orca-linux.AppImage'))).toBe(true)
  })

  it('renders the validated server docs URL when present', () => {
    const guide = serverGuide({
      installKind: 'unknown',
      docsUrl: 'https://github.com/stablyai/orca/blob/main/docs/reference/other.md'
    })
    expect(guide.links).toContainEqual({
      label: 'Server-provided update docs',
      url: 'https://github.com/stablyai/orca/blob/main/docs/reference/other.md'
    })
  })
})

describe('detected line composition', () => {
  it('joins only resolved fields', () => {
    expect(serverGuide({ installKind: 'unknown', restartKind: 'systemd' }).detectedLine).toBe(
      'Detected: systemd service.'
    )
    expect(serverGuide({ installKind: 'linux-rpm', restartKind: 'desktop' }).detectedLine).toBe(
      'Detected: RPM package, desktop app.'
    )
    expect(serverGuide({ installKind: 'unknown', restartKind: 'unknown' }).detectedLine).toBeNull()
  })
})
