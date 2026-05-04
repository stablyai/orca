import type { IDisposable, ILink, ILinkProvider } from '@xterm/xterm'
import { detectLanguage } from '@/lib/language-detect'
import {
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  toWorktreeRelativePath
} from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { openHttpLink } from '@/lib/http-link-routing'

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: Map<string, boolean>
}

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<Pick<MouseEvent, 'shiftKey' | 'preventDefault' | 'stopPropagation'>>

function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

export function getTerminalFileOpenHint(): string {
  return isMacPlatform() ? '⌘+click to open' : 'Ctrl+click to open'
}

// Why: .html/.htm files are routed straight into Orca's embedded browser rather
// than the Monaco editor (which would just show the source), matching the
// standalone "Open Preview to the Side" entry point. Advertise the different
// behavior in the hover tooltip so users know a click will render the page.
export function getTerminalHtmlFileOpenHint(): string {
  return isMacPlatform() ? '⌘+click to open in browser' : 'Ctrl+click to open in browser'
}

export function getTerminalUrlOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
}

function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

function openHtmlFileInBrowser(filePath: string, worktreeId: string): void {
  const store = useAppStore.getState()
  if (worktreeId) {
    // Why: following an HTML file link changes which worktree is foregrounded,
    // so it must record a history visit before opening the browser tab.
    activateAndRevealWorktree(worktreeId)
  }
  const fileUrl = absolutePathToFileUri(filePath)
  const title = filePath.split(/[/\\]/).pop() ?? filePath
  store.createBrowserTab(worktreeId, fileUrl, { title, activate: true })
}

export function openDetectedFilePath(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'>
): void {
  const { worktreeId, worktreePath } = deps

  void (async () => {
    let statResult
    try {
      const connectionId = getConnectionId(deps.worktreeId ?? null) ?? undefined
      // Why: remote paths don't need local auth — the relay is the security boundary.
      if (!connectionId) {
        await window.api.fs.authorizeExternalPath({ targetPath: filePath })
      }
      statResult = await window.api.fs.stat({ filePath, connectionId })
    } catch {
      return
    }

    if (statResult.isDirectory) {
      await window.api.shell.openFilePath(filePath)
      return
    }

    // Why: .html/.htm files render in Orca's embedded browser instead of opening
    // as source in Monaco — ⌘/Ctrl+click on an HTML path in the terminal should
    // feel like clicking an http link and render the page, not dump HTML source.
    // Mirrors the editor's "Open Preview to the Side" action.
    if (isHtmlFilePath(filePath)) {
      openHtmlFileInBrowser(filePath, worktreeId)
      return
    }

    let relativePath = filePath
    if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
      if (maybeRelative !== null && maybeRelative.length > 0) {
        relativePath = maybeRelative
      }
    }

    const store = useAppStore.getState()
    if (worktreeId) {
      // Why: terminal file links can jump across worktrees. Reusing the shared
      // activation path keeps those jumps in the same history stack as sidebar
      // and palette navigation before the editor opens the destination file.
      activateAndRevealWorktree(worktreeId)
    }

    store.openFile({
      filePath,
      relativePath,
      worktreeId: worktreeId || '',
      language: detectLanguage(filePath),
      mode: 'edit'
    })

    if (line !== null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent('orca:editor-reveal-location', {
              detail: { filePath, line, column }
            })
          )
        })
      })
    }
  })()
}

export function createFilePathLinkProvider(
  paneId: number,
  deps: LinkHandlerDeps,
  linkTooltip: HTMLElement,
  openLinkHint: string
): ILinkProvider {
  const { startupCwd, managerRef, pathExistsCache, worktreeId, worktreePath } = deps
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const pane = managerRef.current?.getPanes().find((candidate) => candidate.id === paneId)
      if (!pane) {
        callback(undefined)
        return
      }

      const bufferLine = pane.terminal.buffer.active.getLine(bufferLineNumber - 1)
      const lineText = bufferLine?.translateToString(true)
      if (!lineText) {
        callback(undefined)
        return
      }

      const fileLinks = extractTerminalFileLinks(lineText)
      if (fileLinks.length === 0) {
        callback(undefined)
        return
      }

      void Promise.all(
        fileLinks.map(async (parsed): Promise<ILink | null> => {
          const resolved = startupCwd ? resolveTerminalFileLink(parsed, startupCwd) : null
          if (!resolved) {
            return null
          }

          const cachedExists = pathExistsCache.get(resolved.absolutePath)
          const exists = cachedExists ?? (await window.api.shell.pathExists(resolved.absolutePath))
          pathExistsCache.set(resolved.absolutePath, exists)
          if (!exists) {
            return null
          }

          return {
            range: {
              // Why: xterm's IBufferRange uses 1-based *inclusive* coords on
              // both ends (the hit-test is `x >= start.x && x <= end.x`),
              // but `parsed.endIndex` is the exclusive string-slice end.
              // Converting start = +1 but end = +0 maps correctly so the
              // underline stops on the last filename cell instead of bleeding
              // into the trailing whitespace of column-padded `ls` output.
              start: { x: parsed.startIndex + 1, y: bufferLineNumber },
              end: { x: parsed.endIndex, y: bufferLineNumber }
            },
            text: parsed.displayText,
            activate: (event) => {
              if (!isTerminalLinkActivation(event)) {
                return
              }
              openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, {
                worktreeId,
                worktreePath
              })
            },
            hover: () => {
              // Why: HTML files get a distinct hint because ⌘/Ctrl+click opens
              // them rendered in the embedded browser, not as source in the
              // editor — parallels the "open in system browser" affordance
              // shown for http URLs.
              const hint = isHtmlFilePath(resolved.absolutePath)
                ? getTerminalHtmlFileOpenHint()
                : openLinkHint
              linkTooltip.textContent = `${resolved.absolutePath} (${hint})`
              linkTooltip.style.display = ''
            },
            leave: () => {
              linkTooltip.style.display = 'none'
            }
          }
        })
      ).then((resolvedLinks) => {
        const links = resolvedLinks.filter((link): link is ILink => link !== null)
        callback(links.length > 0 ? links : undefined)
      })
    }
  }
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  const isMac = isMacPlatform()
  return isMac ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'>
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
    // Only local files are supported — remote hosts (file://remote/…) are rejected
    // because we cannot open them as local paths.
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return
    }
    let filePath = decodeURIComponent(parsed.pathname)
    // Why: on Windows, file:///C:/foo yields pathname "/C:/foo". The leading
    // slash must be stripped to produce a valid Windows path ("C:/foo").
    if (/^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1)
    }
    openDetectedFilePath(filePath, null, null, deps)
  }
}
