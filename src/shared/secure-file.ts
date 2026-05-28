import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

let cachedWindowsUserSid: string | null | undefined

export function writeSecureJsonFile(targetPath: string, value: unknown): void {
  writeSecureFile(targetPath, JSON.stringify(value, null, 2))
}

export function writeSecureFile(targetPath: string, contents: string): void {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  hardenSecurePath(dir, { isDirectory: true, platform: process.platform })

  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpFile, contents, {
      encoding: 'utf-8',
      mode: 0o600
    })
    hardenSecurePath(tmpFile, { isDirectory: false, platform: process.platform })
    renameSync(tmpFile, targetPath)
    // Why: these files carry runtime auth/device credentials; the published
    // path must remain current-user only after the atomic rename.
    hardenSecurePath(targetPath, { isDirectory: false, platform: process.platform })
  } catch (error) {
    rmSync(tmpFile, { force: true })
    throw error
  }
}

export function hardenExistingSecureFile(targetPath: string): void {
  const dir = dirname(targetPath)
  if (existsSync(dir)) {
    hardenSecurePath(dir, { isDirectory: true, platform: process.platform })
  }
  if (existsSync(targetPath)) {
    hardenSecurePath(targetPath, { isDirectory: false, platform: process.platform })
  }
}

export function hardenSecurePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
  }
): void {
  if (options.platform === 'win32') {
    bestEffortRestrictWindowsPath(targetPath)
    return
  }
  chmodSync(targetPath, options.isDirectory ? 0o700 : 0o600)
}

function bestEffortRestrictWindowsPath(targetPath: string): void {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return
  }
  try {
    execFileSync(
      'icacls',
      [
        targetPath,
        '/inheritance:r',
        '/grant:r',
        `*${currentUserSid}:(F)`,
        '*S-1-5-18:(F)',
        '*S-1-5-32-544:(F)'
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      }
    )
  } catch {
    // Why: credential-file hardening should not prevent Orca from starting on
    // Windows machines where icacls is unavailable or locked down differently.
  }
}

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    }).trim()
    const columns = parseCsvLine(output)
    cachedWindowsUserSid = columns[1] ?? null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}
