import { translate } from '@/i18n/i18n'

const KNOWN_CLI_DETAILS: {
  test: RegExp | string
  key: string
  fallback: string
  vars?: (match: RegExpMatchArray | null, raw: string) => Record<string, string | number>
}[] = [
  {
    test: 'Development mode uses a generated launcher for validation only.',
    key: 'auto.lib.cli.detail.devLauncherOnly',
    fallback: 'Development mode uses a generated launcher for validation only.'
  },
  {
    test: 'The bundled CLI launcher is missing from this Orca build.',
    key: 'auto.lib.cli.detail.launcherMissing',
    fallback: 'The bundled CLI launcher is missing from this Orca build.'
  },
  {
    test: 'CLI registration is not implemented on this platform.',
    key: 'auto.lib.cli.detail.platformUnsupported',
    fallback: 'CLI registration is not implemented on this platform.'
  },
  {
    test: 'CLI registration is unavailable on this build.',
    key: 'auto.lib.cli.detail.registrationUnavailable',
    fallback: 'CLI registration is unavailable on this build.'
  },
  {
    test: 'WSL CLI registration is unavailable.',
    key: 'auto.lib.cli.detail.wslRegistrationUnavailable',
    fallback: 'WSL CLI registration is unavailable.'
  },
  {
    test: 'WSL CLI registration is only available on Windows.',
    key: 'auto.lib.cli.detail.wslWindowsOnly',
    fallback: 'WSL CLI registration is only available on Windows.'
  },
  {
    test: 'No WSL distribution is available.',
    key: 'auto.lib.cli.detail.noWslDistro',
    fallback: 'No WSL distribution is available.'
  },
  {
    test: 'The Windows Orca CLI launcher is missing.',
    key: 'auto.lib.cli.detail.windowsLauncherMissing',
    fallback: 'The Windows Orca CLI launcher is missing.'
  },
  {
    test: 'Unable to resolve the WSL home directory.',
    key: 'auto.lib.cli.detail.wslHomeUnresolved',
    fallback: 'Unable to resolve the WSL home directory.'
  },
  {
    test: 'WSL Windows interop is unavailable; Orca cannot launch the Windows CLI from WSL.',
    key: 'auto.lib.cli.detail.wslInteropUnavailable',
    fallback: 'WSL Windows interop is unavailable; Orca cannot launch the Windows CLI from WSL.'
  },
  {
    test: 'The Orca launcher exists, but Orca could not check your Windows user PATH.',
    key: 'auto.lib.cli.detail.windowsPathCheckFailed',
    fallback: 'The Orca launcher exists, but Orca could not check your Windows user PATH.'
  },
  {
    test: /WSL command timed out after (\d+)ms\.?/i,
    key: 'auto.lib.cli.detail.wslCommandTimedOut',
    fallback: 'WSL command timed out after {{ms}}ms.',
    vars: (match) => ({ ms: match?.[1] ?? '10000' })
  },
  {
    test: /Windows PATH command timed out after (\d+)ms\.?/i,
    key: 'auto.lib.cli.detail.windowsPathTimedOut',
    fallback: 'Windows PATH command timed out after {{ms}}ms.',
    vars: (match) => ({ ms: match?.[1] ?? '10000' })
  },
  {
    test: /Registered at (.+)\.?$/,
    key: 'auto.lib.cli.detail.registeredAt',
    fallback: 'Registered at {{path}}.',
    vars: (match) => ({ path: (match?.[1] ?? '').replace(/\.$/, '') })
  },
  {
    test: /Registered in (.+) at (.+)\.?$/,
    key: 'auto.lib.cli.detail.registeredInDistroAt',
    fallback: 'Registered in {{distro}} at {{path}}.',
    vars: (match) => ({
      distro: match?.[1] ?? '',
      path: (match?.[2] ?? '').replace(/\.$/, '')
    })
  },
  {
    test: /(.+) exists but is not an Orca launcher script\.?$/,
    key: 'auto.lib.cli.detail.notOrcaLauncherScript',
    fallback: '{{path}} exists but is not an Orca launcher script.',
    vars: (match) => ({ path: match?.[1] ?? '' })
  },
  {
    test: /(.+) exists but is not an Orca symlink\.?$/,
    key: 'auto.lib.cli.detail.notOrcaSymlink',
    fallback: '{{path}} exists but is not an Orca symlink.',
    vars: (match) => ({ path: match?.[1] ?? '' })
  },
  {
    test: /(.+) points to a different launcher\.?$/,
    key: 'auto.lib.cli.detail.differentLauncher',
    fallback: '{{path}} points to a different launcher.',
    vars: (match) => ({ path: match?.[1] ?? '' })
  },
  {
    test: /(.+) contains an older Orca launcher\.?$/,
    key: 'auto.lib.cli.detail.olderLauncher',
    fallback: '{{path}} contains an older Orca launcher.',
    vars: (match) => ({ path: match?.[1] ?? '' })
  }
]

const KNOWN_ANDROID_MESSAGES: { test: string; key: string; fallback: string }[] = [
  {
    test: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.',
    key: 'auto.lib.emulator.androidSdkNotFound',
    fallback: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.'
  }
]

function stripElectronInvokePrefix(raw: string): string {
  const match = raw.match(/Error invoking remote method '[^']+': Error:\s*(.+)$/s)
  return match?.[1]?.trim() || raw
}

/** Path may be blank when status is still resolving — keep a usable command token. */
function registerPathToken(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : 'orca'
}

/** Map stable English "Register … to use Orca from …" status details. */
function formatRegisterCliDetail(normalized: string): string | null {
  const wsl = normalized.match(/^Register\s*(.*?)\s+to use Orca from WSL\.?$/i)
  if (wsl) {
    return translate(
      'auto.lib.cli.detail.registerForWsl',
      'Register {{path}} to use Orca from WSL.',
      { path: registerPathToken(wsl[1]) }
    )
  }
  const terminal = normalized.match(/^Register\s*(.*?)\s+to use Orca from the terminal\.?$/i)
  if (terminal) {
    return translate(
      'auto.lib.cli.detail.registerForTerminal',
      'Register {{path}} to use Orca from the terminal.',
      { path: registerPathToken(terminal[1]) }
    )
  }
  const windowsShell = normalized.match(
    /^Register\s*(.*?)\s+to use Orca from Command Prompt or PowerShell\.?$/i
  )
  if (windowsShell) {
    return translate(
      'auto.lib.cli.detail.registerForWindowsShell',
      'Register {{path}} to use Orca from Command Prompt or PowerShell.',
      { path: registerPathToken(windowsShell[1]) }
    )
  }
  return null
}

export function formatCliUserFacingDetail(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  const normalized = stripElectronInvokePrefix(raw.trim())
  const registerCopy = formatRegisterCliDetail(normalized)
  if (registerCopy) {
    return registerCopy
  }
  for (const known of KNOWN_CLI_DETAILS) {
    if (typeof known.test === 'string') {
      if (normalized === known.test || normalized.includes(known.test)) {
        return translate(known.key, known.fallback)
      }
      continue
    }
    const match = normalized.match(known.test)
    if (match) {
      return translate(known.key, known.fallback, known.vars?.(match, normalized))
    }
  }
  return normalized
}

export function formatEmulatorAvailabilityUserFacingMessage(
  raw: string | null | undefined
): string {
  if (!raw?.trim()) {
    return ''
  }
  const android = formatAndroidSdkUserFacingMessage(raw)
  if (android !== raw) {
    return android
  }
  return formatCliUserFacingDetail(raw)
}

export function formatAndroidSdkUserFacingMessage(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  for (const known of KNOWN_ANDROID_MESSAGES) {
    if (raw === known.test || raw.includes(known.test)) {
      return translate(known.key, known.fallback)
    }
  }
  return raw
}
