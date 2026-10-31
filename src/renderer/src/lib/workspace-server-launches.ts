import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'

export type WorkspaceServerLaunch = {
  id: string
  runtimeTarget: RuntimeClientTarget
  executionHostId: string
  worktreeId: string
  repoId: string
  name: string
  port: number
  command: string
  cwd: string
  sourcePtyId?: string
  workspacePath: string
}

const STORAGE_KEY = 'orca.workspace-server-launches.v1'
let records: WorkspaceServerLaunch[] | undefined
const listeners = new Set<() => void>()

export function workspaceServerLaunchKey(
  target: RuntimeClientTarget,
  host: string,
  worktreeId: string,
  port: number
): string {
  return JSON.stringify([
    target.kind === 'local' ? 'local' : target.environmentId,
    host,
    worktreeId,
    port
  ])
}

const launchSchema = z.object({
  id: z.string(),
  runtimeTarget: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }),
    z.object({ kind: z.literal('environment'), environmentId: z.string().min(1) })
  ]),
  executionHostId: z.string().min(1),
  worktreeId: z.string().min(1),
  repoId: z.string().min(1),
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  command: z
    .string()
    .min(1)
    .max(16384)
    .refine((value) => value.trim().length > 0),
  cwd: z.string().min(1),
  workspacePath: z.string().min(1),
  sourcePtyId: z.string().optional()
})

export function parseWorkspaceServerLaunches(value: unknown): WorkspaceServerLaunch[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.slice(0, 128).flatMap((item: unknown) => {
    const parsed = launchSchema.safeParse(item)
    if (!parsed.success) {
      return []
    }
    const entry = parsed.data
    return entry.id ===
      workspaceServerLaunchKey(
        entry.runtimeTarget,
        entry.executionHostId,
        entry.worktreeId,
        entry.port
      )
      ? [entry]
      : []
  })
}

export function workspaceServerLogPort(
  entry: WorkspaceServerLaunch
): WorkspacePort & { kind: 'workspace' } {
  return {
    id: entry.id,
    kind: 'workspace',
    bindHost: '127.0.0.1',
    connectHost: 'localhost',
    port: entry.port,
    protocol: 'unknown',
    sourcePtyId: entry.sourcePtyId,
    owner: {
      worktreeId: entry.worktreeId,
      repoId: entry.repoId,
      displayName: entry.name,
      path: entry.workspacePath,
      confidence: 'command'
    }
  }
}

export function getWorkspaceServerLaunches(): WorkspaceServerLaunch[] {
  if (!records) {
    try {
      records = parseWorkspaceServerLaunches(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'))
    } catch {
      records = []
    }
  }
  return records
}

function publish(next: WorkspaceServerLaunch[]): void {
  records = next
  for (const listener of listeners) {
    listener()
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function saveWorkspaceServerLaunch(entry: WorkspaceServerLaunch): void {
  if (parseWorkspaceServerLaunches([entry]).length !== 1) {
    throw new Error('Invalid server configuration')
  }
  const next = [...getWorkspaceServerLaunches().filter((item) => item.id !== entry.id), entry]
  if (next.length > 128) {
    throw new Error('Too many saved servers')
  }
  publish(next)
}

export function removeWorkspaceServerLaunch(id: string): void {
  publish(getWorkspaceServerLaunches().filter((entry) => entry.id !== id))
}

export function useWorkspaceServerLaunches(): WorkspaceServerLaunch[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, getWorkspaceServerLaunches)
}

export function matchingWorkspaceServerPort(
  entry: WorkspaceServerLaunch,
  scan: WorkspacePortScanResult | null
): (WorkspacePort & { kind: 'workspace' }) | undefined {
  return scan?.ports.find(
    (port): port is WorkspacePort & { kind: 'workspace' } =>
      port.kind === 'workspace' &&
      port.owner.worktreeId === entry.worktreeId &&
      port.port === entry.port
  )
}
