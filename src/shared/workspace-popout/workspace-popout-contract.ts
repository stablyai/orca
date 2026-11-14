import type { DashboardCardTerminalInput } from '../dashboard-snapshot'
import { isRemoteRuntimePtyId } from '../remote-runtime/remote-runtime-pty-id'

export const WORKSPACE_POPOUT_ID_MAX_LENGTH = 4096
export const WORKSPACE_POPOUT_TITLE_MAX_LENGTH = 256
export const WORKSPACE_POPOUT_MIN_WIDTH = 480
export const WORKSPACE_POPOUT_MIN_HEIGHT = 360
export const WORKSPACE_POPOUT_DEFAULT_WIDTH = 960
export const WORKSPACE_POPOUT_DEFAULT_HEIGHT = 720
export const WORKSPACE_POPOUT_PARTITION = 'orca-workspace-popout'

export type WorkspacePopoutTarget = {
  worktreeId: string
  tabId: string
  ptyId: string
  terminalInput: DashboardCardTerminalInput | null
  title: string
}

export type WorkspacePopoutState = 'opening' | 'open' | 'recovering' | 'closing'

export type WorkspacePopoutCloseReason =
  | 'docked'
  | 'replaced'
  | 'window-closed'
  | 'crashed'
  | 'main-closed'
  | 'flag-disabled'
  | 'pty-gone'
  | 'app-quit'

export type WorkspacePopoutEntrySummary = {
  worktreeId: string
  tabId: string
  ptyId: string
  state: WorkspacePopoutState
}

export type WorkspacePopoutOpenResult =
  | { status: 'opened' | 'focused' }
  | {
      status: 'rejected'
      reason: 'flag-disabled' | 'invalid-payload' | 'remote-runtime-pty' | 'closing'
    }

export type WorkspacePopoutStateChanged =
  | { worktreeId: string; tabId: string; open: true }
  | { worktreeId: string; tabId: string; open: false; reason: WorkspacePopoutCloseReason }

export type WorkspacePopoutWindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

function isNonEmptyStringUnderLimit(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function validateWorkspacePopoutTarget(
  value: unknown
):
  | { valid: true; target: WorkspacePopoutTarget }
  | { valid: false; reason: 'invalid-payload' | 'remote-runtime-pty' } {
  if (typeof value !== 'object' || value === null) {
    return { valid: false, reason: 'invalid-payload' }
  }
  const candidate = value as Record<string, unknown>
  if (!isNonEmptyStringUnderLimit(candidate.worktreeId, WORKSPACE_POPOUT_ID_MAX_LENGTH)) {
    return { valid: false, reason: 'invalid-payload' }
  }
  if (!isNonEmptyStringUnderLimit(candidate.tabId, WORKSPACE_POPOUT_ID_MAX_LENGTH)) {
    return { valid: false, reason: 'invalid-payload' }
  }
  if (!isNonEmptyStringUnderLimit(candidate.ptyId, WORKSPACE_POPOUT_ID_MAX_LENGTH)) {
    return { valid: false, reason: 'invalid-payload' }
  }
  if (isRemoteRuntimePtyId(candidate.ptyId)) {
    return { valid: false, reason: 'remote-runtime-pty' }
  }
  if (
    typeof candidate.title !== 'string' ||
    candidate.title.length > WORKSPACE_POPOUT_TITLE_MAX_LENGTH
  ) {
    return { valid: false, reason: 'invalid-payload' }
  }
  if (candidate.terminalInput !== null && typeof candidate.terminalInput !== 'object') {
    return { valid: false, reason: 'invalid-payload' }
  }
  return {
    valid: true,
    target: {
      worktreeId: candidate.worktreeId,
      tabId: candidate.tabId,
      ptyId: candidate.ptyId,
      terminalInput: candidate.terminalInput as DashboardCardTerminalInput | null,
      title: candidate.title
    }
  }
}

export function isWorkspacePopoutTarget(value: unknown): value is WorkspacePopoutTarget {
  return validateWorkspacePopoutTarget(value).valid
}

export function isWorkspacePopoutDockArgs(value: unknown): value is { worktreeId: string } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return isNonEmptyStringUnderLimit(candidate.worktreeId, WORKSPACE_POPOUT_ID_MAX_LENGTH)
}

export type WorkspacePopoutGlobalSettings = {
  /** Experimental: pop out workspace terminals into dedicated companion windows. */
  experimentalWorkspacePopout?: boolean
}
