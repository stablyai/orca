import { readFile } from 'node:fs/promises'
import { getProcessOutputFields, iterateProcessOutputLines } from './process-output-field-scanner'

const GENERIC_LINUX_RIPGREP_INSTALL =
  'install ripgrep via your package manager (e.g. apt/dnf/pacman)'
const OS_RELEASE_ID_LIKE_MAX_FIELDS = 16

export async function detectInstallCommand(): Promise<string> {
  if (process.platform === 'darwin') {
    return 'brew install ripgrep'
  }
  if (process.platform === 'linux') {
    try {
      const osRelease = await readFile('/etc/os-release', 'utf-8')
      return detectLinuxInstallCommandFromOsRelease(osRelease)
    } catch {
      /* fall through to generic guidance */
    }
    return GENERIC_LINUX_RIPGREP_INSTALL
  }
  return 'install ripgrep (https://github.com/BurntSushi/ripgrep#installation)'
}

export function detectLinuxInstallCommandFromOsRelease(osRelease: string): string {
  for (const id of getOsReleasePackageFamilyIds(osRelease)) {
    if (id === 'debian' || id === 'ubuntu') {
      return 'sudo apt install ripgrep'
    }
    if (id === 'fedora' || id === 'rhel' || id === 'centos') {
      return 'sudo dnf install ripgrep'
    }
    if (id === 'arch') {
      return 'sudo pacman -S ripgrep'
    }
    if (id === 'alpine') {
      return 'sudo apk add ripgrep'
    }
  }

  return GENERIC_LINUX_RIPGREP_INSTALL
}

function getOsReleasePackageFamilyIds(osRelease: string): string[] {
  const ids: string[] = []

  for (const line of iterateProcessOutputLines(osRelease)) {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex)
    const value = readOsReleaseValue(line.slice(separatorIndex + 1))
    if (key === 'ID') {
      const id = getProcessOutputFields(value, 1)[0]
      if (id) {
        ids.push(id)
      }
    } else if (key === 'ID_LIKE') {
      ids.push(...getProcessOutputFields(value, OS_RELEASE_ID_LIKE_MAX_FIELDS))
    }
  }

  return ids
}

function readOsReleaseValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  const quote = trimmed[0]
  return (quote === '"' || quote === "'") && trimmed.at(-1) === quote
    ? trimmed.slice(1, -1)
    : trimmed
}

export async function buildInstallRgMessage(
  cause: unknown,
  host: 'local' | 'remote' = 'local'
): Promise<string> {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const cmd = await detectInstallCommand()
  const location = host === 'local' ? 'on the host running the Quick Open scan' : 'on the remote'
  return (
    `Quick Open scan too large (${reason}). ` +
    `Install ripgrep ${location} to enable fast, gitignore-aware listing: ${cmd}`
  )
}
