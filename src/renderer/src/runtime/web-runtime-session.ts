import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  BrowserTabCreateResult,
  RuntimeTerminalCreate,
  RuntimeTerminalSplit
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'

export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Why: host session surface ids use `tab::leaf`, but renderer pane keys
  // reserve `:` as the tab/leaf delimiter. Keep host identity while making a
  // local tab id that can safely flow through makePaneKey().
  return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(hostSurfaceId)}`
}

function toHostSessionTabId(tabId: string): string {
  if (!tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)) {
    return tabId
  }
  try {
    return decodeURIComponent(tabId.slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length))
  } catch {
    return tabId
  }
}

export function isWebRuntimeSessionActive(
  activeRuntimeEnvironmentId: string | null | undefined
): boolean {
  return (
    Boolean((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) &&
    Boolean(activeRuntimeEnvironmentId?.trim())
  )
}

export async function createWebRuntimeSessionTerminal(args: {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  command?: string
  activate?: boolean
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'terminal.create',
      params: {
        worktree: `id:${args.worktreeId}`,
        command: args.command,
        activate: args.activate !== false
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ terminal: RuntimeTerminalCreate }>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create terminal:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function createWebRuntimeSessionBrowserTab(args: {
  worktreeId: string
  environmentId?: string | null
  url?: string
  profileId?: string | null
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'browser.tabCreate',
      params: {
        worktree: `id:${args.worktreeId}`,
        url: args.url,
        profileId: args.profileId ?? undefined
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<BrowserTabCreateResult>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to create browser tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function activateWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.activate', args)
}

export async function closeWebRuntimeSessionTab(args: {
  worktreeId: string
  tabId: string
  environmentId?: string | null
}): Promise<boolean> {
  return callWebRuntimeSessionTabMethod('session.tabs.close', args)
}

async function callWebRuntimeSessionTabMethod(
  method: 'session.tabs.activate' | 'session.tabs.close',
  args: {
    worktreeId: string
    tabId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  try {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method,
      params: {
        worktree: `id:${args.worktreeId}`,
        tabId: toHostSessionTabId(args.tabId)
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    return true
  } catch (error) {
    console.warn(
      `[web-runtime-session] failed to ${method === 'session.tabs.close' ? 'close' : 'activate'} tab:`,
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export function splitWebRuntimeTerminal(
  ptyId: string | null | undefined,
  direction: 'horizontal' | 'vertical'
): boolean {
  if (!ptyId) {
    return false
  }
  const remote = parseRemoteRuntimePtyId(ptyId)
  const environmentId = remote?.environmentId?.trim()
  if (!remote || !environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }

  // Why: split requests from the paired web client must run on the host pane.
  // A local split would mint a web-only pane and the host would mirror it back
  // as a separate tab instead of preserving the terminal split layout.
  void window.api.runtimeEnvironments
    .call({
      selector: environmentId,
      method: 'terminal.split',
      params: {
        terminal: remote.handle,
        direction
      },
      timeoutMs: 15_000
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeTerminalSplit>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to split terminal:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
