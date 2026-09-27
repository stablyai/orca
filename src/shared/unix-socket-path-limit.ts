/**
 * `sizeof(sun_path)` per OS, including the terminating NUL: 108 on Linux (and
 * Windows AF_UNIX), 104 on macOS/BSD. Compare against byte length, not
 * character count — a non-ASCII path costs more bytes than characters.
 */
const SUN_PATH_SIZE: Record<'linux' | 'darwin', number> = { linux: 108, darwin: 104 }

/** Longest socket path, in UTF-8 bytes, that fits `sun_path` beside its NUL. */
export function unixSocketPathByteLimit(os: 'linux' | 'darwin'): number {
  return SUN_PATH_SIZE[os] - 1
}
