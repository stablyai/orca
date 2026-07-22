import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import {
  extractOrchestrationTaskLinks,
  focusRuntimeOrchestrationTask,
  ORCHESTRATION_TASK_PREFIX
} from './terminal-orchestration-task-links'

export { extractOrchestrationTaskLinks } from './terminal-orchestration-task-links'
export type { ParsedOrchestrationTaskLink } from './terminal-orchestration-task-links'

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

const TERMINAL_HANDLE_PREFIX = 'term_'
const MAX_TERMINAL_HANDLE_BODY_LENGTH = 128
const TERMINAL_HANDLE_BOUNDARY_CHAR = /[A-Za-z0-9_-]/

export function extractTerminalHandleLinks(lineText: string): ParsedTerminalHandleLink[] {
  return extractPrefixedTokenLinks(lineText, TERMINAL_HANDLE_PREFIX).map((link) => ({
    handle: link.token,
    startIndex: link.startIndex,
    endIndex: link.endIndex
  }))
}

function extractPrefixedTokenLinks(
  lineText: string,
  prefix: string
): { token: string; startIndex: number; endIndex: number }[] {
  if (!lineText.includes(prefix)) {
    return []
  }

  const links: { token: string; startIndex: number; endIndex: number }[] = []
  let searchStart = 0
  while (searchStart < lineText.length) {
    const startIndex = lineText.indexOf(prefix, searchStart)
    if (startIndex === -1) {
      break
    }

    const bodyStart = startIndex + prefix.length
    const tokenEnd = findPrefixedTokenEnd(lineText, bodyStart)
    searchStart = Math.max(tokenEnd, bodyStart + 1)
    const bodyLength = tokenEnd - bodyStart
    if (bodyLength === 0 || bodyLength > MAX_TERMINAL_HANDLE_BODY_LENGTH) {
      continue
    }

    const token = lineText.slice(startIndex, tokenEnd)
    if (
      TERMINAL_HANDLE_BOUNDARY_CHAR.test(lineText[startIndex - 1] ?? '') ||
      TERMINAL_HANDLE_BOUNDARY_CHAR.test(lineText[tokenEnd] ?? '')
    ) {
      continue
    }
    links.push({ token, startIndex, endIndex: tokenEnd })
  }
  return links
}

function findPrefixedTokenEnd(lineText: string, startIndex: number): number {
  let index = startIndex
  while (index < lineText.length && TERMINAL_HANDLE_BOUNDARY_CHAR.test(lineText[index])) {
    index += 1
  }
  return index
}

export function findTerminalHandleTarget(
  handle: string,
  state: TerminalHandleFocusState,
  runtimeEnvironmentId?: string | null
): TerminalHandleTarget | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = state.terminalLayoutsByTabId[tab.id]
      for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (ptyIdMatchesTerminalHandle(ptyId, handle, runtimeEnvironmentId)) {
          return { worktreeId, tabId: tab.id, leafId }
        }
      }

      const tabPtyIds = [tab.ptyId, ...(state.ptyIdsByTabId[tab.id] ?? [])].filter(
        (ptyId): ptyId is string => Boolean(ptyId)
      )
      if (
        tabPtyIds.some((ptyId) => ptyIdMatchesTerminalHandle(ptyId, handle, runtimeEnvironmentId))
      ) {
        return { worktreeId, tabId: tab.id, leafId: layout?.activeLeafId ?? null }
      }
    }
  }
  return null
}

export function focusRendererTerminalHandle(
  handle: string,
  runtimeEnvironmentId?: string | null
): boolean {
  const store = useAppStore.getState()
  const target = findTerminalHandleTarget(handle, store, runtimeEnvironmentId)
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
      if (
        !logicalLine ||
        (!logicalLine.text.includes(TERMINAL_HANDLE_PREFIX) &&
          !logicalLine.text.includes(ORCHESTRATION_TASK_PREFIX))
      ) {
        callback(undefined)
        return
      }

      const terminalLinks = extractTerminalHandleLinks(logicalLine.text).map((parsed) => ({
        kind: 'terminal' as const,
        text: parsed.handle,
        startIndex: parsed.startIndex,
        endIndex: parsed.endIndex
      }))
      const taskLinks = extractOrchestrationTaskLinks(logicalLine.text).map((parsed) => ({
        kind: 'task' as const,
        text: parsed.taskId,
        startIndex: parsed.startIndex,
        endIndex: parsed.endIndex
      }))
      const links = [...terminalLinks, ...taskLinks]
        .sort((a, b) => a.startIndex - b.startIndex)
        .map((parsed): ILink | null => {
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (!range) {
            return null
          }
          return {
            range,
            text: parsed.text,
            activate: (event) => {
              if (!isTerminalHandleLinkActivation(event)) {
                return
              }
              event?.preventDefault()
              void activateParsedLink(parsed, deps.getRuntimeEnvironmentId())
              terminal.clearSelection()
            },
            hover: () => {
              deps.linkTooltip.textContent = `${parsed.text} (${getTerminalHandleFocusHint()})`
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

async function activateParsedLink(
  parsed: { kind: 'terminal' | 'task'; text: string },
  runtimeEnvironmentId: string | null
): Promise<void> {
  try {
    if (parsed.kind === 'terminal') {
      if (!focusRendererTerminalHandle(parsed.text, runtimeEnvironmentId)) {
        await focusRuntimeTerminalHandle(parsed.text, runtimeEnvironmentId)
      }
      return
    }
    // Why: a task can be retried onto a new dispatch; runtime DB is the
    // authority for the latest terminal assigned to a stable task ID.
    await focusRuntimeOrchestrationTask(parsed.text, runtimeEnvironmentId, (handle) =>
      focusRendererTerminalHandle(handle, runtimeEnvironmentId)
    )
  } catch (error: unknown) {
    console.warn('[terminal-handle-link] focus failed:', error)
  }
}

function ptyIdMatchesTerminalHandle(
  ptyId: string,
  handle: string,
  runtimeEnvironmentId?: string | null
): boolean {
  const targetEnvironmentId = runtimeEnvironmentId?.trim() || null
  if (ptyId === handle) {
    return targetEnvironmentId === null
  }
  const remotePty = parseRemoteRuntimePtyId(ptyId)
  if (!remotePty || remotePty.handle !== handle) {
    return false
  }
  const ptyEnvironmentId = remotePty.environmentId?.trim() || null
  if (runtimeEnvironmentId === undefined) {
    return true
  }
  return ptyEnvironmentId === targetEnvironmentId
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
  await callRuntimeRpc(target, 'terminal.focus', { terminal: handle, navigation: 'host' })
}
