import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getRemoteRuntimeTerminalHandle } from '@/runtime/runtime-terminal-stream'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

export type ParsedTerminalHandleLink = {
  handle: string
  startIndex: number
  endIndex: number
}

export type TerminalHandleTarget = {
  worktreeId: string
  tabId: string
  leafId: string | null
}

export type TerminalHandleFocusState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
>

type TerminalHandleLinkProviderDeps = {
  getTerminal: () => Terminal | null
  getRuntimeEnvironmentId: () => string | null
  linkTooltip: HTMLElement
}

const TERMINAL_HANDLE_REGEX = /term_[A-Za-z0-9][A-Za-z0-9_-]{0,127}/g
const TERMINAL_HANDLE_BOUNDARY_CHAR = /[A-Za-z0-9_-]/

export function extractTerminalHandleLinks(lineText: string): ParsedTerminalHandleLink[] {
  if (!lineText.includes('term_')) {
    return []
  }

  const links: ParsedTerminalHandleLink[] = []
  for (const match of lineText.matchAll(TERMINAL_HANDLE_REGEX)) {
    const startIndex = match.index ?? 0
    const handle = match[0]
    const endIndex = startIndex + handle.length
    if (
      TERMINAL_HANDLE_BOUNDARY_CHAR.test(lineText[startIndex - 1] ?? '') ||
      TERMINAL_HANDLE_BOUNDARY_CHAR.test(lineText[endIndex] ?? '')
    ) {
      continue
    }
    links.push({ handle, startIndex, endIndex })
  }
  return links
}

export function findTerminalHandleTarget(
  handle: string,
  state: TerminalHandleFocusState
): TerminalHandleTarget | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = state.terminalLayoutsByTabId[tab.id]
      for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyIdMatchesTerminalHandle(ptyId, handle)) {
          return { worktreeId, tabId: tab.id, leafId }
        }
      }

      const tabPtyIds = [tab.ptyId, ...(state.ptyIdsByTabId[tab.id] ?? [])].filter(
        (ptyId): ptyId is string => Boolean(ptyId)
      )
      if (tabPtyIds.some((ptyId) => ptyIdMatchesTerminalHandle(ptyId, handle))) {
        return { worktreeId, tabId: tab.id, leafId: layout?.activeLeafId ?? null }
      }
    }
  }
  return null
}

export function focusRendererTerminalHandle(handle: string): boolean {
  const store = useAppStore.getState()
  const target = findTerminalHandleTarget(handle, store)
  if (!target) {
    return false
  }

  store.setActiveWorktree(target.worktreeId)
  store.markWorktreeVisited(target.worktreeId)
  store.setActiveView('terminal')
  store.setActiveTabType('terminal')
  store.revealWorktreeInSidebar(target.worktreeId)
  if (target.leafId) {
    activateTabAndFocusPane(target.tabId, target.leafId)
  } else {
    store.setActiveTab(target.tabId)
    focusTerminalTabSurface(target.tabId)
  }
  return true
}

export function createTerminalHandleLinkProvider(
  deps: TerminalHandleLinkProviderDeps
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      if (!terminal) {
        callback(undefined)
        return
      }
      const logicalLine = buildWrappedLogicalLine(terminal.buffer.active, bufferLineNumber)
      if (!logicalLine || !logicalLine.text.includes('term_')) {
        callback(undefined)
        return
      }

      const links = extractTerminalHandleLinks(logicalLine.text)
        .map((parsed): ILink | null => {
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (!range) {
            return null
          }
          return {
            range,
            text: parsed.handle,
            activate: (event) => {
              if (!isTerminalHandleLinkActivation(event)) {
                return
              }
              event?.preventDefault()
              if (!focusRendererTerminalHandle(parsed.handle)) {
                void focusRuntimeTerminalHandle(
                  parsed.handle,
                  deps.getRuntimeEnvironmentId()
                ).catch((error: unknown) => {
                  console.warn('[terminal-handle-link] focus failed:', error)
                })
              }
              terminal.clearSelection()
            },
            hover: () => {
              deps.linkTooltip.textContent = `${parsed.handle} (${getTerminalHandleFocusHint()})`
              deps.linkTooltip.style.display = ''
            },
            leave: () => {
              deps.linkTooltip.style.display = 'none'
            }
          }
        })
        .filter((link): link is ILink => link !== null)

      callback(links.length > 0 ? links : undefined)
    }
  }
}

function ptyIdMatchesTerminalHandle(ptyId: string, handle: string): boolean {
  return ptyId === handle || getRemoteRuntimeTerminalHandle(ptyId) === handle
}

function getTerminalHandleFocusHint(): string {
  return navigator.userAgent.includes('Mac')
    ? '⌘+click to switch terminal'
    : 'Ctrl+click to switch terminal'
}

function isTerminalHandleLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  const isMac = navigator.userAgent.includes('Mac')
  return isMac ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

async function focusRuntimeTerminalHandle(
  handle: string,
  runtimeEnvironmentId: string | null
): Promise<void> {
  const environmentId = runtimeEnvironmentId?.trim()
  const target = environmentId
    ? ({ kind: 'environment', environmentId } as const)
    : ({ kind: 'local' } as const)
  // Why: main owns the `term_*` mapping. Defer to terminal.focus on click
  // instead of mirroring that state in renderer hover parsing.
  await callRuntimeRpc(target, 'terminal.focus', { terminal: handle })
}
