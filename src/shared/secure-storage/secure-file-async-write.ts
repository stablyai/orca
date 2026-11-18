import { randomBytes } from 'node:crypto'
import { renameSync } from 'node:fs'
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeSecureFile } from './secure-file'

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

type SecureWriteAsyncOptions = {
  durable?: boolean
  shouldPublish?: () => boolean
  onPublished?: () => void
}

/** `writeSecureFile` without blocking the thread on the staged write or the disk. Windows creates
 *  the restricted file through a synchronous ACL addon, so it writes synchronously there. */
export async function writeSecureFileAsync(
  targetPath: string,
  contents: string,
  options: SecureWriteAsyncOptions = {}
): Promise<boolean> {
  if (process.platform === 'win32') {
    return writeSecureFile(targetPath, contents, options)
  }
  const dir = dirname(targetPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const handle = await open(tmpFile, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      // The umask can strip bits from the mode but never add them; chmod sets exactly 0o600.
      await handle.chmod(0o600)
      if (options.durable) {
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
    if (options.shouldPublish && !options.shouldPublish()) {
      await rm(tmpFile, { force: true })
      return false
    }
    // Sync so the check above and the publish share a turn: a sign-out's clear cannot land between them.
    renameSync(tmpFile, targetPath)
  } catch (error) {
    await rm(tmpFile, { force: true })
    throw error
  }
  options.onPublished?.()
  if (options.durable) {
    await bestEffortFsyncDirectory(dir)
  }
  return true
}

/** Flushes a directory entry off the thread; filesystems without directory fsync are skipped. */
export async function bestEffortFsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (typeof code !== 'string' || !UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) {
      throw error
    }
  }
}
