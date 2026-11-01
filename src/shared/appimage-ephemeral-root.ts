export type AppImageEphemeralRoot = { kind: 'mount' | 'extract'; path: string }

/** The AppImage runtime's per-launch FUSE mount or extract-and-run copy holding path; both vanish with that launch. */
export function appImageEphemeralRootOf(path: string): AppImageEphemeralRoot | null {
  const segments = path.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (segment.startsWith('.mount_')) {
      return { kind: 'mount', path: segments.slice(0, index + 1).join('/') }
    }
    if (segment.startsWith('appimage_extracted_')) {
      return { kind: 'extract', path: segments.slice(0, index + 1).join('/') }
    }
  }
  return null
}
