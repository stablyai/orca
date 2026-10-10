import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serializePathWrite } from './path-write-serializer'
import {
  hardenSecurePathOnce,
  rememberHardenedPath,
  isUnsupportedDirectoryFsyncError,
  type HardeningOutcome
} from './secure-file'
import { recordHardeningOutcome } from './secure-path-hardening-retry-budget'
import { bestEffortRestrictWindowsPath } from './secure-path-windows-acl'

export async function writeSecureJsonFileAsync(
  targetPath: string,
  value: unknown
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2))
}

export async function writeDurableSecureJsonFileAsync(
  targetPath: string,
  value: unknown
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/** Preserves staged ACL verification and optional durability while serializing writes per path. */
export async function writeSecureFileAsync(
  targetPath: string,
  contents: string,
  options: { durable?: boolean } = {}
): Promise<boolean> {
  return await serializePathWrite(targetPath, async () => {
    const dir = dirname(targetPath)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    hardenSecurePathOnce(dir, true)

    const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmpFile, contents, { encoding: 'utf-8', mode: 0o600 })
      if (options.durable) {
        await fsyncFile(tmpFile)
      }
      // Why: writeFile mode is a no-op on Windows, so the credential's ACL must land before the rename publishes it under inherited ACLs.
      const stagedOutcome = await applyWritePathRestriction(tmpFile, false)
      await rename(tmpFile, targetPath)
      // The staged protected DACL survives rename; verify the published path before caching it.
      const publishedOutcome = await applyWritePathRestriction(targetPath, false)
      if (publishedOutcome === 'applied') {
        rememberHardenedPath(targetPath, false)
      }
      if (options.durable) {
        await bestEffortFsyncDirectory(dir)
      }
      return stagedOutcome === 'applied' && publishedOutcome === 'applied'
    } catch (error) {
      await rm(tmpFile, { force: true })
      throw error
    }
  })
}

// Writes remain exempt from the read-path retry budget so recovered permissions are retried.
async function applyWritePathRestriction(
  targetPath: string,
  isDirectory: boolean
): Promise<HardeningOutcome> {
  if (process.platform !== 'win32') {
    await chmod(targetPath, isDirectory ? 0o700 : 0o600)
    return 'applied'
  }
  const restricted = await new Promise<boolean>((resolve) => {
    bestEffortRestrictWindowsPath(targetPath, isDirectory, resolve)
  })
  if (restricted) {
    // Only success clears read-path backoff; failures must remain retryable.
    recordHardeningOutcome(targetPath, true)
  }
  return restricted ? 'applied' : 'failed'
}

async function fsyncPath(path: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await open(path, flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function fsyncFile(path: string): Promise<void> {
  // FlushFileBuffers requires a write-capable handle on Windows.
  await fsyncPath(path, process.platform === 'win32' ? 'r+' : 'r')
}

export async function bestEffortFsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    await fsyncPath(directory, 'r')
  } catch (error) {
    if (isUnsupportedDirectoryFsyncError(error)) {
      return
    }
    throw error
  }
}
