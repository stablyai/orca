import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { lookupWorkspaceSymbol } from '@/lib/lsp/lsp-workspace-symbol-lookup'
import { rankWorkspaceSymbols } from '@/lib/lsp/lsp-workspace-symbol-ranking'
import {
  isTerminalLinkActivation,
  isTerminalLinkDirectActivation
} from './terminal-link-activation'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

const SYMBOL_TOKEN = /[A-Za-z_][A-Za-z0-9_]*(?:(?:::|#|\.)[A-Za-z_][A-Za-z0-9_]*)*[?!]?/g
// ponytail: skips prose words like "for"/"the"; lower it if 3-letter symbols matter.
const MIN_TOKEN_LENGTH = 4

export type TerminalSymbolLinkDeps = {
  getTerminal: () => Terminal | null
  worktreeId: string
  worktreePath: string
  /** Cheap gate: true only when the pane's project has a language server enabled. */
  isLspEnabled: () => boolean
}

export function extractSymbolTokens(
  lineText: string
): { text: string; startIndex: number; endIndex: number }[] {
  const tokens: { text: string; startIndex: number; endIndex: number }[] = []
  for (const match of lineText.matchAll(SYMBOL_TOKEN)) {
    if (match[0].length >= MIN_TOKEN_LENGTH && match.index !== undefined) {
      tokens.push({
        text: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length
      })
    }
  }
  return tokens
}

/** Symbol links need a local repo with at least one enabled language server. */
export function isSymbolLookupEnabledForRepo(repo: Repo | undefined): boolean {
  return (
    repo !== undefined &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    Object.values(repo.languageServers?.enabled ?? {}).some(Boolean)
  )
}

function toFilePath(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') {
      return null
    }
    return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return null
  }
}

async function openSymbolDefinition(token: string, deps: TerminalSymbolLinkDeps): Promise<void> {
  const candidates = await lookupWorkspaceSymbol(deps.worktreeId, token)
  // ponytail: opens the top-ranked match; add a picker if ties turn out common.
  const best = rankWorkspaceSymbols(token, candidates, deps.worktreePath)[0]
  const filePath = best ? toFilePath(best.uri) : null
  if (!best || !filePath) {
    toast(
      translate(
        'auto.components.terminal.pane.TerminalSymbolLinks.noDefinition',
        'No definition found for {{token}}',
        { token }
      )
    )
    return
  }
  openDetectedFilePath(filePath, best.line + 1, best.character + 1, {
    worktreeId: deps.worktreeId,
    worktreePath: deps.worktreePath
  })
}

function setDecorations(link: ILink, armed: boolean): void {
  if (link.decorations) {
    link.decorations.underline = armed
    link.decorations.pointerCursor = armed
  }
}

export function createTerminalSymbolLinkProvider(
  deps: TerminalSymbolLinkDeps
): ILinkProvider & { dispose(): void } {
  // Why: xterm never calls leave() on teardown, so the provider owns the single active watcher.
  let stopWatchingModifier: (() => void) | null = null
  return {
    dispose: () => {
      stopWatchingModifier?.()
      stopWatchingModifier = null
    },
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      const logicalLine =
        terminal && deps.isLspEnabled()
          ? buildWrappedLogicalLine(terminal.buffer.active, bufferLineNumber)
          : null
      if (!terminal || !logicalLine) {
        callback(undefined)
        return
      }
      const links = extractSymbolTokens(logicalLine.text)
        .map((token): ILink | null => {
          const range = rangeForParsedFileLink(logicalLine, token.startIndex, token.endIndex)
          if (!range) {
            return null
          }
          const link: ILink = {
            range,
            text: token.text,
            // Why: every word is a candidate, so only underline while the platform modifier is held.
            decorations: { underline: false, pointerCursor: false },
            hover: (event) => {
              // Why: xterm snapshots decorations before hover() and then swaps in a live proxy on
              // link.decorations, so writes must wait a microtask and go through the link itself.
              const armed = isTerminalLinkActivation(event)
              queueMicrotask(() => setDecorations(link, armed))
              stopWatchingModifier?.()
              const onKey = (keyEvent: KeyboardEvent): void => {
                if (terminal.element?.isConnected === false) {
                  stop()
                  return
                }
                setDecorations(link, isTerminalLinkActivation(keyEvent))
              }
              const stop = (): void => {
                document.removeEventListener('keydown', onKey, { capture: true })
                document.removeEventListener('keyup', onKey, { capture: true })
                if (stopWatchingModifier === stop) {
                  stopWatchingModifier = null
                }
              }
              // Why: capture so key handlers that stopPropagation can't hide modifier presses.
              document.addEventListener('keydown', onKey, { capture: true })
              document.addEventListener('keyup', onKey, { capture: true })
              stopWatchingModifier = stop
            },
            leave: () => {
              stopWatchingModifier?.()
              setDecorations(link, false)
            },
            activate: (event) => {
              if (!isTerminalLinkDirectActivation(event)) {
                return
              }
              event.preventDefault()
              terminal.clearSelection()
              void openSymbolDefinition(token.text, deps)
            }
          }
          return link
        })
        .filter((link): link is ILink => link !== null)
      callback(links.length > 0 ? links : undefined)
    }
  }
}
