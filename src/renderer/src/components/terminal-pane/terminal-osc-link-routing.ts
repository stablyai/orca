import { resolveTerminalFileLinkText } from '@/lib/terminal-links'
import { openHttpLink } from '@/lib/http-link-routing'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { isTerminalLinkActivation } from './terminal-link-handlers'
import { resolveTerminalFileUrlTarget } from './terminal-file-url-target'
import { openDetectedFilePath } from './terminal-file-open-routing'

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<Pick<MouseEvent, 'shiftKey' | 'preventDefault' | 'stopPropagation'>>

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
    Partial<Pick<LinkHandlerDeps, 'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath'>>
): void {
  if (!isTerminalLinkActivation(event)) {
    return
  }

  // Why: xterm renders URL links as clickable anchors. Once Orca decides to
  // handle a modified click itself, we must suppress the browser's default
  // anchor navigation or Electron will still launch the system browser.
  // Note: we intentionally do NOT stopPropagation here — xterm's
  // SelectionService listens for mouseup on ownerDocument to clear the
  // pending drag-select state initiated by the mousedown of the same click.
  // Stopping propagation leaves SelectionService's mousemove/mouseup handlers
  // attached, so returning focus to the terminal and moving the mouse (even
  // without holding a button) extends a selection until the next click/Esc.
  event?.preventDefault?.()

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    const resolved = resolveTerminalFileLinkText(
      rawText,
      deps.startupCwd || deps.worktreePath,
      deps.terminalHomePath
    )
    if (resolved) {
      openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, deps)
    }
    return
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    openHttpLink(parsed.toString(), {
      worktreeId: deps.worktreeId,
      forceSystemBrowser: Boolean(event?.shiftKey)
    })
    return
  }

  if (parsed.protocol === 'file:') {
    // Why: file:// URIs should open inside Orca, not via the OS default editor
    // (shell.openPath). We extract the path from the URI and route it through
    // the same openDetectedFilePath logic used for detected file-path links.
    // Only local files are supported — remote hosts (file://remote/...) are rejected
    // because we cannot open them as local paths.
    const resolved = resolveTerminalFileUrlTarget(parsed)
    if (!resolved) {
      return
    }
    openDetectedFilePath(resolved.filePath, resolved.line, resolved.column, deps)
  }
}
