import { normalizeAbsolutePath } from '@/components/right-sidebar/file-explorer-paths'

// Why: the editor's own save path writes to disk, which fans out as an
// fs:changed event back to useEditorExternalWatch a few ms later. Treating
// our own write as an "external" change schedules a setContent reload that
// resets the TipTap selection to the end of the document mid-typing — and,
// because the RichMarkdownEditor guards (lastCommittedMarkdownRef + current
// getMarkdown() round-trip) can drift by a trailing newline or soft-break,
// the reload can silently drop unsaved keystrokes as well. Stamping a path
// right before writeFile lets the watch hook ignore the echo event without
// touching the editor at all. Keyed by normalized absolute path, bounded by
// a short TTL so a genuinely external edit that lands after the window still
// gets picked up.
const SELF_WRITE_TTL_MS = 750

const stamps = new Map<string, number>()

export function recordSelfWrite(absolutePath: string): void {
  stamps.set(normalizeAbsolutePath(absolutePath), Date.now() + SELF_WRITE_TTL_MS)
}

export function clearSelfWrite(absolutePath: string): void {
  stamps.delete(normalizeAbsolutePath(absolutePath))
}

export function hasRecentSelfWrite(absolutePath: string): boolean {
  const key = normalizeAbsolutePath(absolutePath)
  const expiry = stamps.get(key)
  if (expiry === undefined) {
    return false
  }
  if (Date.now() > expiry) {
    stamps.delete(key)
    return false
  }
  return true
}

export function __clearSelfWriteRegistryForTests(): void {
  stamps.clear()
}
