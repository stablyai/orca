import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  applyTerminalQuickCommandMutation,
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../../../../shared/terminal-quick-commands'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentConnectionGeneration } from './runtime-status'

export type RuntimeTerminalQuickCommands = {
  commands: TerminalQuickCommand[]
  connectionGeneration: number
  error: string | null
  loading: boolean
  ready: boolean
  supported: boolean | null
}

export type TerminalQuickCommandHostsSlice = {
  runtimeTerminalQuickCommands: Map<string, RuntimeTerminalQuickCommands>
  loadRuntimeTerminalQuickCommands: (
    environmentId: string,
    options?: { force?: boolean }
  ) => Promise<void>
  upsertTerminalQuickCommand: (
    hostId: ExecutionHostId,
    command: TerminalQuickCommand
  ) => Promise<boolean>
  deleteTerminalQuickCommand: (hostId: ExecutionHostId, commandId: string) => Promise<boolean>
  retainRuntimeTerminalQuickCommands: (environmentIds: Iterable<string>) => void
}

const mutationChains = new Map<string, Promise<void>>()
const mutationRevisions = new Map<string, number>()
const loadRequests = new Map<string, { connectionGeneration: number; request: Promise<void> }>()

function readCommands(result: unknown): TerminalQuickCommand[] {
  const raw = (result as { terminalQuickCommands?: unknown } | null)?.terminalQuickCommands
  const commands = parseNormalizedTerminalQuickCommands(raw)
  if (!commands) {
    throw new Error('Remote Orca returned invalid quick commands.')
  }
  return commands
}

function updateEntry(
  set: Parameters<StateCreator<AppState>>[0],
  environmentId: string,
  update: (current: RuntimeTerminalQuickCommands | undefined) => RuntimeTerminalQuickCommands
): void {
  set((state) => {
    const next = new Map(state.runtimeTerminalQuickCommands)
    next.set(environmentId, update(next.get(environmentId)))
    return { runtimeTerminalQuickCommands: next }
  })
}

async function mutateLocalCommands(
  get: Parameters<StateCreator<AppState>>[1],
  mutation: TerminalQuickCommandMutation
): Promise<boolean> {
  try {
    const current = get().settings?.terminalQuickCommands ?? []
    const next = applyTerminalQuickCommandMutation(current, mutation)
    await get().updateSettingsOrThrow({ terminalQuickCommands: next })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save quick command.'
    toast.error(
      translate(
        'auto.store.slices.terminal.quick.command.hosts.5b7d781d67',
        'Failed to save quick command'
      ),
      { description: message }
    )
    return false
  }
}

async function mutateRemoteCommands(
  set: Parameters<StateCreator<AppState>>[0],
  environmentId: string,
  mutation: TerminalQuickCommandMutation
): Promise<boolean> {
  mutationRevisions.set(environmentId, (mutationRevisions.get(environmentId) ?? 0) + 1)
  const previous = mutationChains.get(environmentId) ?? Promise.resolve()
  let succeeded = false
  const request = previous.then(async () => {
    const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
    try {
      const result = await callRuntimeRpc<{ terminalQuickCommands: unknown }>(
        { kind: 'environment', environmentId },
        'settings.updateTerminalQuickCommands',
        { mutation },
        { timeoutMs: 15_000 }
      )
      const commands = readCommands(result)
      if (getRuntimeEnvironmentConnectionGeneration(environmentId) !== connectionGeneration) {
        return
      }
      updateEntry(set, environmentId, (current) => ({
        ...current,
        commands,
        connectionGeneration,
        error: null,
        loading: false,
        ready: true,
        supported: true
      }))
      succeeded = true
    } catch (error) {
      if (getRuntimeEnvironmentConnectionGeneration(environmentId) !== connectionGeneration) {
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to save quick command.'
      updateEntry(set, environmentId, (current) => ({
        commands: current?.commands ?? [],
        connectionGeneration,
        error: message,
        loading: false,
        ready: current?.ready ?? false,
        supported: current?.supported ?? null
      }))
      toast.error(
        translate(
          'auto.store.slices.terminal.quick.command.hosts.5b7d781d67',
          'Failed to save quick command'
        ),
        { description: message }
      )
    }
  })
  mutationChains.set(environmentId, request)
  await request
  if (mutationChains.get(environmentId) === request) {
    mutationChains.delete(environmentId)
  }
  return succeeded
}

export const createTerminalQuickCommandHostsSlice: StateCreator<
  AppState,
  [],
  [],
  TerminalQuickCommandHostsSlice
> = (set, get) => ({
  runtimeTerminalQuickCommands: new Map(),

  loadRuntimeTerminalQuickCommands: async (environmentId, options) => {
    const trimmed = environmentId.trim()
    if (!trimmed) {
      return
    }
    const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(trimmed)
    const current = get().runtimeTerminalQuickCommands.get(trimmed)
    if (
      !options?.force &&
      current?.ready &&
      current.connectionGeneration === connectionGeneration
    ) {
      return
    }
    const existing = loadRequests.get(trimmed)
    if (existing?.connectionGeneration === connectionGeneration) {
      return existing.request
    }
    const request = (async () => {
      updateEntry(set, trimmed, (entry) => ({
        commands:
          entry?.connectionGeneration === connectionGeneration ? (entry.commands ?? []) : [],
        connectionGeneration,
        error: null,
        loading: true,
        ready:
          entry?.connectionGeneration === connectionGeneration ? (entry.ready ?? false) : false,
        supported:
          entry?.connectionGeneration === connectionGeneration ? (entry.supported ?? null) : null
      }))
      try {
        const supported = await runtimeEnvironmentSupportsCapability(
          trimmed,
          TERMINAL_QUICK_COMMANDS_RUNTIME_CAPABILITY,
          15_000
        )
        if (getRuntimeEnvironmentConnectionGeneration(trimmed) !== connectionGeneration) {
          return
        }
        if (!supported) {
          updateEntry(set, trimmed, () => ({
            commands: [],
            connectionGeneration,
            error: null,
            loading: false,
            ready: true,
            supported: false
          }))
          return
        }
        await (mutationChains.get(trimmed) ?? Promise.resolve())
        const mutationRevision = mutationRevisions.get(trimmed) ?? 0
        const result = await callRuntimeRpc<{ terminalQuickCommands: unknown }>(
          { kind: 'environment', environmentId: trimmed },
          'settings.getTerminalQuickCommands',
          undefined,
          { timeoutMs: 15_000 }
        )
        if (
          getRuntimeEnvironmentConnectionGeneration(trimmed) !== connectionGeneration ||
          (mutationRevisions.get(trimmed) ?? 0) !== mutationRevision
        ) {
          return
        }
        updateEntry(set, trimmed, () => ({
          commands: readCommands(result),
          connectionGeneration,
          error: null,
          loading: false,
          ready: true,
          supported: true
        }))
      } catch (error) {
        if (getRuntimeEnvironmentConnectionGeneration(trimmed) !== connectionGeneration) {
          return
        }
        updateEntry(set, trimmed, (entry) => ({
          commands: entry?.commands ?? [],
          connectionGeneration,
          error: error instanceof Error ? error.message : 'Failed to load quick commands.',
          loading: false,
          ready: entry?.ready ?? false,
          supported: entry?.supported ?? null
        }))
      }
    })()
    const trackedRequest = { connectionGeneration, request }
    loadRequests.set(trimmed, trackedRequest)
    try {
      await request
    } finally {
      if (loadRequests.get(trimmed) === trackedRequest) {
        loadRequests.delete(trimmed)
      }
    }
  },

  upsertTerminalQuickCommand: async (hostId, command) => {
    const parsed = parseExecutionHostId(hostId)
    if (!parsed || parsed.kind !== 'runtime') {
      return mutateLocalCommands(get, { type: 'upsert', command })
    }
    return mutateRemoteCommands(set, parsed.environmentId, { type: 'upsert', command })
  },

  deleteTerminalQuickCommand: async (hostId, commandId) => {
    const parsed = parseExecutionHostId(hostId)
    if (!parsed || parsed.kind !== 'runtime') {
      return mutateLocalCommands(get, { type: 'delete', id: commandId })
    }
    return mutateRemoteCommands(set, parsed.environmentId, { type: 'delete', id: commandId })
  },

  retainRuntimeTerminalQuickCommands: (environmentIds) => {
    const keep = new Set(environmentIds)
    set((state) => {
      const next = new Map(state.runtimeTerminalQuickCommands)
      let changed = false
      for (const id of next.keys()) {
        if (!keep.has(id)) {
          next.delete(id)
          mutationChains.delete(id)
          mutationRevisions.delete(id)
          loadRequests.delete(id)
          changed = true
        }
      }
      return changed ? { runtimeTerminalQuickCommands: next } : state
    })
  }
})
