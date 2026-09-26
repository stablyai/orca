import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bestEffortRestrictWindowsPath } from './secure-path-windows-acl'
import { WORKER_REPORT_MAX_BYTES } from './worker-report-record'

const hardened = new Map<string, string>()

export async function secureWorkerReportPath(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Worker report storage must not be a symlink')
  }
  if (process.platform !== 'win32') {
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error('Worker report storage has a different owner')
    }
    const mode = directory ? 0o700 : 0o600
    if ((stat.mode & 0o777) !== mode) {
      await chmod(path, mode)
    }
    return
  }
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${directory ? '' : `${stat.ctimeMs}:${stat.size}`}`
  if (hardened.get(path) === identity) {
    return
  }
  const restricted = await new Promise<boolean>((resolve) =>
    bestEffortRestrictWindowsPath(path, directory, resolve)
  )
  if (!restricted) {
    throw new Error('Cannot securely access worker report storage')
  }
  if (hardened.size >= 512) {
    hardened.clear()
  }
  hardened.set(path, identity)
}

export async function readWorkerReportFile(path: string): Promise<unknown> {
  await secureWorkerReportPath(path, false)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > WORKER_REPORT_MAX_BYTES) {
      throw new Error('Worker report exceeds storage limit')
    }
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    if (offset !== stat.size) {
      throw new Error('Worker report changed during read')
    }
    return JSON.parse(bytes.subarray(0, offset).toString('utf8'))
  } finally {
    await file.close()
  }
}

export async function syncWorkerReportDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const file = await open(directory, 'r')
  try {
    await file.sync()
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        'code' in error &&
        ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))
      )
    ) {
      throw error
    }
  } finally {
    await file.close()
  }
}

export async function writeWorkerReportFile(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(text) > WORKER_REPORT_MAX_BYTES) {
    throw new Error('Worker report exceeds storage limit')
  }
  await secureWorkerReportPath(dirname(path), true)
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    // Restrict the empty file before writing credentials, including on inherited Windows ACLs.
    await secureWorkerReportPath(temporary, false)
    await file.writeFile(text, 'utf8')
    await file.sync()
    await file.close()
    await rename(temporary, path)
    await syncWorkerReportDirectory(dirname(path))
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}
