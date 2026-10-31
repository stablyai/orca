import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { posix } from 'node:path'

/** The strict logical gate grants only this derived physical publication. */
export async function writeHookFileAtomically(
  logicalPath: string,
  content: string,
  requiredMode?: number
): Promise<void> {
  let target: string
  try {
    target = await fs.realpath(logicalPath)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error.code !== 'ENOENT' && error.code !== 'ELOOP')
    ) {
      throw error
    }
    target = logicalPath
  }
  let equal = false
  try {
    equal = (await fs.readFile(target, 'utf8')) === content
  } catch {
    // A failed read still has to pass the physical publication permissions.
  }
  if (equal) {
    if (requiredMode !== undefined) {
      await fs.chmod(target, requiredMode)
    }
    return
  }
  const parent = posix.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  let mode = requiredMode
  if (mode === undefined) {
    try {
      mode = (await fs.stat(target)).mode & 0o7777
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ELOOP')
      ) {
        throw error
      }
      mode = 0o600
    }
  }
  const temporary = posix.join(parent, `.${Date.now()}-${randomUUID()}.tmp`)
  const file = await fs.open(temporary, 'wx', mode)
  try {
    try {
      await file.writeFile(content, 'utf8')
      await fs.chmod(temporary, mode)
    } finally {
      await file.close()
    }
    await fs.rename(temporary, target)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}
