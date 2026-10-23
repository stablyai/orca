import { closeSync, openSync, readSync } from 'node:fs'

const NATIVE_EXECUTABLE_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a] // Windows PE
]

/** A compiled binary runs on no `node`, so pairing would only reorder PATH (Homebrew, /usr/bin). */
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

// Why: Win32 resolves env names case-insensitively and object order preserves
// the block order, so the entry the child will actually read is the FIRST
// case-insensitive match — not necessarily `Path` or `PATH`. Reading a narrower
// set than withCliRuntimeOnPath's twin dedupe deletes would destroy a third spelling unread.
// Mirrors resolvePathEnvKey in src/main/pty/windows-path-segment-merge.ts, which
// src/shared must not import.
export function firstWindowsPathEnvKey(env: NodeJS.ProcessEnv): string {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && env[key] !== undefined) {
      return key
    }
  }
  return 'Path'
}
