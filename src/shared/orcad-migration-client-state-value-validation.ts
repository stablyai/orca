import type { WorkspaceHostScope } from './ui-chrome-types'
import type { SavedPortForward } from './ssh-types'
import { requiredRecord } from './orcad-migration-dormant-value-validation'
import { boundedStringArray } from './orcad-migration-manifest-fields'

export function parseStringArray(value: unknown, max: number): string[] {
  return boundedStringArray(
    value,
    max,
    'orcad_migration_dormant_ui_routing_invalid',
    'orcad_migration_dormant_ui_routing_duplicate'
  )
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
