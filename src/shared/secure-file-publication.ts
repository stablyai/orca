import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { restrictWindowsPath } from './secure-path-windows-acl'

type PublicationOperation = { deadline: number; signal: AbortSignal }
function checkOperation(operation: PublicationOperation): void {
  if (operation.signal.aborted || Date.now() >= operation.deadline) {
    throw new Error('Protected file publication cancelled')
  }
}
async function protect(
  path: string,
  directory: boolean,
  operation: PublicationOperation
): Promise<void> {
  checkOperation(operation)
  const before = await lstat(path)
  if (
    before.isSymbolicLink() ||
    before.isDirectory() !== directory ||
    (!directory && !before.isFile())
  ) {
    throw new Error('Unsafe protected file path')
  }
  if (process.platform === 'win32') {
    if (!(await restrictWindowsPath(path, directory, operation))) {
      throw new Error('Private file protection failed')
    }
  } else {
    if (before.uid !== process.getuid?.()) {
      throw new Error('Unsafe protected file owner')
    }
    await chmod(path, directory ? 0o700 : 0o600)
    const after = await lstat(path)
    if (
      (after.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new Error('Private file protection failed')
    }
  }
  checkOperation(operation)
}

export async function writeProtectedFileAtomic(
  path: string,
  contents: Buffer,
  operation: PublicationOperation
): Promise<void> {
  checkOperation(operation)
  const directory = dirname(path)
  const created = await mkdir(directory, { recursive: true, mode: 0o700 })
  if (created) {
    let current = created
    await protect(current, true, operation)
    for (const segment of relative(created, directory).split(sep).filter(Boolean)) {
      current = join(current, segment)
      await protect(current, true, operation)
    }
  } else {
    await protect(directory, true, operation)
  }
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  let published = false
  try {
    await protect(temporary, false, operation)
    let offset = 0
    while (offset < contents.length) {
      checkOperation(operation)
      const { bytesWritten } = await file.write(contents, offset, contents.length - offset, offset)
      if (bytesWritten <= 0) {
        throw new Error('Protected file write made no progress')
      }
      offset += bytesWritten
    }
    await file.sync()
    await file.close()
    checkOperation(operation)
    await rename(temporary, path)
    published = true
    await protect(path, false, operation)
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
    checkOperation(operation)
  } catch (error) {
    if (published) {
      throw new Error(
        'Protected file was published; refresh to verify its protection and contents',
        { cause: error }
      )
    }
    throw error
  } finally {
    await file.close().catch(() => undefined)
    if (!published) {
      await rm(temporary, { force: true })
    }
  }
}
