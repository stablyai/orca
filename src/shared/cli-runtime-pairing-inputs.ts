import { closeSync, openSync, readSync } from 'node:fs'

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
    return NATIVE_EXECUTABLE_MAGIC.some(
      (magic) => read >= magic.length && magic.every((byte, index) => head[index] === byte)
    )
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
