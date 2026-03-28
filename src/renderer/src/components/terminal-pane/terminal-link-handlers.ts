import type { IDisposable, ILink, ILinkProvider } from '@xterm/xterm'
import { detectLanguage } from '@/lib/language-detect'
import {
  extractTerminalFileLinks,
  isPathInsideWorktree,
  resolveTerminalFileLink,
  toWorktreeRelativePath
} from '@/lib/terminal-links'
import { useAppStore } from '@/store'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: Map<string, boolean>
}

export function openDetectedFilePath(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'>
): void {
  const { worktreeId, worktreePath } = deps

  void (async () => {
    const pathExists = await window.api.shell.pathExists(filePath)
    if (!pathExists) {
      return
    }

    if (worktreePath && isPathInsideWorktree(filePath, worktreePath)) {
      const relativePath = toWorktreeRelativePath(filePath, worktreePath)
      if (relativePath === null || relativePath.length === 0) {
        return
      }

      const store = useAppStore.getState()
      store.setActiveWorktree(worktreeId)
      store.openFile({
        filePath,
        relativePath,
        worktreeId,
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
      return
    }

    await window.api.shell.openFilePath(filePath)
  })()
}

export function createFilePathLinkProvider(paneId: number, deps: LinkHandlerDeps): ILinkProvider {
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
            activate: () => {
              openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, {
                worktreeId,
                worktreePath
              })
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

export function isTerminalLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined): boolean {
  const isMac = navigator.userAgent.includes('Mac')
  return isMac ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

export function handleOscLink(
  rawText: string,
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): void {
  if (!isTerminalLinkActivation(event)) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    void window.api.shell.openUrl(parsed.toString())
    return
  }

  if (parsed.protocol === 'file:') {
    void window.api.shell.openFileUri(parsed.toString())
  }
}
