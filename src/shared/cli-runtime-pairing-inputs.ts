import { closeSync, constants, openSync, readSync } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const NATIVE_EXECUTABLE_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a] // Windows PE
]

/** Compiled binaries need no Node PATH pairing, which would only reorder Homebrew/system entries. */
export function isNativeExecutable(commandPath: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(commandPath, 'r')
    const head = Buffer.alloc(4)
    const read = readSync(fd, head, 0, head.length, 0)
    return hasNativeSignature(head, read)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

// Windows reads the first case-insensitive PATH match; mirror windows-path-segment-merge without importing main so dedupe cannot discard an unread alias.
export function firstWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && env[key] !== undefined) {
      return key
    }
  }
  return 'Path'
}

function hasNativeSignature(head: Buffer, read: number): boolean {
  return NATIVE_EXECUTABLE_MAGIC.some(
    (magic) => read >= magic.length && magic.every((byte, index) => head[index] === byte)
  )
}

/** Advisory preparation only; read failures never suppress an execution attempt. */
export async function installedCliRuntimeDirectory(
  command: string,
  acceptPath: (path: string) => boolean
): Promise<string | null> {
  const directory = dirname(command)
  const node = `${directory}/node`
  if (!acceptPath(node)) {
    return null
  }
  try {
    if (!(await stat(node)).isFile()) {
      return null
    }
    await access(node, constants.X_OK)
  } catch {
    return null
  }
  if (!acceptPath(command)) {
    return null
  }
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(command, constants.O_RDONLY | constants.O_NONBLOCK)
    // Inspect the acquired object: a pathname check can race with replacement by a stream.
    if ((await file.stat()).isFile()) {
      const head = Buffer.alloc(4)
      const { bytesRead } = await file.read(head, 0, head.length, 0)
      if (hasNativeSignature(head, bytesRead)) {
        return null
      }
    }
  } catch {
    // Match synchronous pairing: an unreadable signature is not recognized as native.
  } finally {
    try {
      await file?.close()
    } catch {
      // Advisory cleanup cannot override the runtime result or refuse execution.
    }
  }
  return directory
}
