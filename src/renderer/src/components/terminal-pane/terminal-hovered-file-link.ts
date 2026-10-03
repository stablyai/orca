import type { IBufferRange, Terminal } from '@xterm/xterm'
import { isRevealInFileManagerBlocked, revealInFileManager } from '@/lib/reveal-in-file-manager'
import { useAppStore } from '@/store'
import { rangeContainsBufferPosition } from './terminal-file-link-hit-testing'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'

type HoveredTerminalFileLink = {
  /** As the host that owns the file addresses it. */
  path: string
  range: IBufferRange
  /** False when the worktree's files live on another host. */
  clientOsCanOpen: boolean
}

export type TerminalFileLinkReveal = {
  path: string
  /** The OS file manager cannot show it: the file lives on another host. */
  blocked: boolean
}

// Why: keyed by terminal so the record dies with the pane instead of needing teardown wiring.
const hoveredFileLinks = new WeakMap<Terminal, { link: HoveredTerminalFileLink; exists: boolean }>()

/** Records the link under the pointer; pass `exists` for a link not yet known to name a real file. */
export function setHoveredTerminalFileLink(
  terminal: Terminal,
  link: HoveredTerminalFileLink | null,
  exists?: Promise<boolean>
): void {
  if (!link) {
    hoveredFileLinks.delete(terminal)
    return
  }
  // Why: a late answer lands on this hover's own record, which the next hover or leave replaces.
  const hover = { link, exists: !exists }
  hoveredFileLinks.set(terminal, hover)
  exists?.then(
    (found) => {
      hover.exists = found
    },
    () => {}
  )
}

/** What the context menu can offer to reveal for a right-click on an existing file link, if any. */
export function terminalFileLinkRevealAtMouseEvent(
  terminal: Terminal,
  event: MouseEvent,
  transport: Parameters<typeof resolveTerminalHttpLinkSourceOwner>[0]
): TerminalFileLinkReveal | null {
  const hover = hoveredFileLinks.get(terminal)
  if (!hover?.exists) {
    return null
  }
  // Why: xterm keeps a link hovered after it scrolls out from under a still pointer.
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  if (!position || !rangeContainsBufferPosition(hover.link.range, position, terminal.cols)) {
    return null
  }
  return {
    path: hover.link.path,
    // Why: the OS reveal cannot tell another host's path from a local one of the same name.
    blocked:
      !hover.link.clientOsCanOpen ||
      resolveTerminalHttpLinkSourceOwner(transport).kind !== 'local' ||
      isRevealInFileManagerBlocked(useAppStore.getState().settings, {})
  }
}

async function isClientLocalDirectory(path: string): Promise<boolean> {
  try {
    await window.api.fs.authorizeExternalPath({ targetPath: path })
    return (await window.api.fs.stat({ filePath: path })).isDirectory
  } catch {
    return false
  }
}

/** Shows a revealed link in the OS file manager: a directory opens, a file is selected in its folder. */
export async function revealTerminalFileLink({ path }: TerminalFileLinkReveal): Promise<void> {
  if (
    !isRevealInFileManagerBlocked(useAppStore.getState().settings, {}) &&
    (await isClientLocalDirectory(path)) &&
    (await window.api.shell.openFilePath(path))
  ) {
    return
  }
  // Why: also the path that reports a missing or remote target.
  await revealInFileManager(path)
}
