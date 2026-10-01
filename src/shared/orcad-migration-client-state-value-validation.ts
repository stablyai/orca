import type { WorkspaceHostScope } from './ui-chrome-types'
import type { SavedPortForward } from './ssh-types'

export function parseStringArray(value: unknown, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every((entry) => typeof entry === 'string' && entry)
  ) {
    throw new Error('orcad_migration_dormant_ui_routing_invalid')
  }
  if (new Set(value).size !== value.length) {
    throw new Error('orcad_migration_dormant_ui_routing_duplicate')
  }
  return [...value]
}

export function positivePort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`orcad_migration_dormant_saved_port_forward_${label}_invalid`)
  }
  return Number(value)
}

export function parseSavedPortForwards(value: unknown, max: number): SavedPortForward[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error('orcad_migration_dormant_saved_port_forwards_invalid')
  }
  const usedPorts = new Set<number>()
  return value.map((entry) => {
    const record = requiredRecord(entry, 'orcad_migration_dormant_saved_port_forward_invalid')
    const localPort = positivePort(record.localPort, 'local_port')
    if (usedPorts.has(localPort)) {
      throw new Error('orcad_migration_dormant_saved_port_forwards_duplicate')
    }
    usedPorts.add(localPort)
    const remotePort = positivePort(record.remotePort, 'remote_port')
    if (typeof record.remoteHost !== 'string' || !record.remoteHost.trim()) {
      throw new Error('orcad_migration_dormant_saved_port_forward_invalid')
    }
    if (record.label !== undefined && typeof record.label !== 'string') {
      throw new Error('orcad_migration_dormant_saved_port_forward_invalid')
    }
    return {
      localPort,
      remoteHost: record.remoteHost,
      remotePort,
      ...(record.label !== undefined ? { label: record.label } : {})
    }
  })
}

export function nullableString(value: unknown): string | null {
  if (value !== null && value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error('orcad_migration_dormant_ui_routing_invalid')
  }
  return value == null ? null : value
}

export function isWorkspaceHostScope(value: unknown): value is WorkspaceHostScope {
  return value === 'all' || isWorkspaceHostId(value)
}

export function isWorkspaceHostId(value: unknown): value is Exclude<WorkspaceHostScope, 'all'> {
  return (
    value === 'local' ||
    (typeof value === 'string' && (value.startsWith('ssh:') || value.startsWith('runtime:')))
  )
}

export function requiredRecord(value: unknown, error: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(error)
  }
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
