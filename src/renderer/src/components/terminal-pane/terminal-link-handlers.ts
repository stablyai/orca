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
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

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

export function getTerminalUrlOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
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

    let relativePath = filePath
    if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(filePath, worktreePath)
      if (maybeRelative !== null && maybeRelative.length > 0) {
        relativePath = maybeRelative
      }
    }

    const store = useAppStore.getState()
    if (worktreeId) {
      store.setActiveWorktree(worktreeId)
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
              start: { x: parsed.startIndex + 1, y: bufferLineNumber },
              end: { x: parsed.endIndex + 1, y: bufferLineNumber }
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
              linkTooltip.textContent = `${resolved.absolutePath} (${openLinkHint})`
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
  event?.preventDefault?.()
  event?.stopPropagation?.()

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const store = useAppStore.getState()
    // Why: openLinksInApp controls whether Cmd/Ctrl+click routes http(s) URLs
    // into Orca's embedded browser or passes them to the system browser.
    // Shift is always the explicit override to the system browser regardless of
    // the setting. Default is true so new installs get in-app routing.
    const routeToOrca =
      deps.worktreeId && !event?.shiftKey && store.settings?.openLinksInApp !== false
    if (routeToOrca) {
      store.setActiveWorktree(deps.worktreeId)
      store.createBrowserTab(deps.worktreeId, parsed.toString())
      return
    }
    void window.api.shell.openUrl(parsed.toString())
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
