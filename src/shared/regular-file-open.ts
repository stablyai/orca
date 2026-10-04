import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
// A replaced FIFO must not pin a threadpool slot before descriptor validation.
const OPEN_NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

export async function openRegularFileReadHandle(
  path: string,
  errorMessage = 'Expected a regular file',
  signal?: AbortSignal
): Promise<FileHandle> {
  signal?.throwIfAborted()
  const before = await lstat(path)
  if (!before.isFile()) {
    throw new Error(errorMessage)
  }
  signal?.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK)
  try {
    signal?.throwIfAborted()
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)])
    signal?.throwIfAborted()
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error(errorMessage)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
