import type { DashboardRevealAgentArgs } from './dashboard-snapshot'

/** A renderer-provided target that the macOS Dock can route back to the main window. */
export type DockAgentEntry = {
  id: string
  label: string
  target: DashboardRevealAgentArgs
}

export type DockAgentMenuPayload = {
  active: DockAgentEntry[]
  unread: DockAgentEntry[]
}

export const DOCK_AGENT_MENU_UPDATE = 'app:setDockAgentMenu'
export const DOCK_AGENT_OPEN = 'app:openDockAgent'

/** Keep a renderer update from creating an unbounded native menu. */
export const MAX_DOCK_AGENT_ENTRIES = 200
export const MAX_DOCK_AGENT_ID_LENGTH = 4_096
export const MAX_DOCK_AGENT_LABEL_LENGTH = 240

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isDashboardRevealTarget(value: unknown): value is DashboardRevealAgentArgs {
  if (!isRecord(value)) {
    return false
  }
  return (
    isBoundedString(value.repoId, MAX_DOCK_AGENT_ID_LENGTH) &&
    isBoundedString(value.worktreeId, MAX_DOCK_AGENT_ID_LENGTH) &&
    (value.executionHostId === undefined ||
      isBoundedString(value.executionHostId, MAX_DOCK_AGENT_ID_LENGTH)) &&
    isBoundedString(value.tabId, MAX_DOCK_AGENT_ID_LENGTH) &&
    (value.leafId === null || isBoundedString(value.leafId, MAX_DOCK_AGENT_ID_LENGTH))
  )
}

function readEntries(value: unknown, group: string): DockAgentEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DOCK_AGENT_ENTRIES) {
    throw new Error(`Invalid Dock ${group} agents`)
  }

  const ids = new Set<string>()
  return value.map((raw): DockAgentEntry => {
    if (!isRecord(raw)) {
      throw new Error(`Invalid Dock ${group} agent`)
    }
    const id = raw.id
    const label = raw.label
    const target = raw.target
    if (
      !isBoundedString(id, MAX_DOCK_AGENT_ID_LENGTH) ||
      !isBoundedString(label, MAX_DOCK_AGENT_LABEL_LENGTH) ||
      !isDashboardRevealTarget(target) ||
      ids.has(id)
    ) {
      throw new Error(`Invalid Dock ${group} agent`)
    }
    ids.add(id)
    const normalizedLabel = label.replace(/[\r\n\t]/g, ' ').trim()
    if (!normalizedLabel) {
      throw new Error(`Invalid Dock ${group} agent label`)
    }
    return {
      id,
      label: Array.from(normalizedLabel).slice(0, MAX_DOCK_AGENT_LABEL_LENGTH).join(''),
      target
    }
  })
}

/** Validates and bounds the renderer-controlled native Dock menu payload. */
export function readDockAgentMenuPayload(value: unknown): DockAgentMenuPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid Dock agent menu')
  }
  return {
    active: readEntries(value.active, 'active'),
    unread: readEntries(value.unread, 'unread')
  }
}
