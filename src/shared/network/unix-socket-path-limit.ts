/** sun_path includes NUL: 108 bytes on Linux/Windows AF_UNIX, 104 on macOS/BSD. Measure UTF-8 bytes, not characters. */
const SUN_PATH_SIZE: Record<'linux' | 'darwin', number> = { linux: 108, darwin: 104 }

/** Longest socket path, in UTF-8 bytes, that fits `sun_path` beside its NUL. */
function unixSocketPathByteLimit(os: 'linux' | 'darwin'): number {
  return SUN_PATH_SIZE[os] - 1
}

export function unixSocketPathFits(socketPath: string, os: 'linux' | 'darwin'): boolean {
  return new TextEncoder().encode(socketPath).length <= unixSocketPathByteLimit(os)
}
