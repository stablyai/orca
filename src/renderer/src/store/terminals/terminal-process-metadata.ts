import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import { resolvePrimaryLayoutPtyId } from './terminal-pty-identities'
import type { TerminalState } from './terminal-state'

export type TerminalProcessFacts = {
  incarnationId?: string
  shellPath?: string
  wslDistro?: string | null
}
export type TerminalProcessMetadata = { observationRevision: number; incarnationId?: string } & (
  | { retired: true }
  | (TerminalProcessFacts & { retired?: never })
)
export type TerminalProcessMetadataState = Pick<
  TerminalState,
  'ptyProcessMetadataById' | 'ptyProcessObservationRevision'
>

export function terminalProcessMetadataKey(host: ExecutionHostId, id: string): string {
  return `${host}\0${id}`
}

export function readTerminalProcessMetadata(
  state: Pick<TerminalState, 'ptyProcessMetadataById'>,
  host: ExecutionHostId,
  id: string
) {
  const entry = state.ptyProcessMetadataById[terminalProcessMetadataKey(host, id)]
  return entry?.retired ? undefined : entry
}

function replaceEntry(
  state: TerminalProcessMetadataState,
  key: string,
  entry: TerminalProcessMetadata
): TerminalProcessMetadataState {
  return {
    ptyProcessObservationRevision: Math.max(
      state.ptyProcessObservationRevision,
      entry.observationRevision
    ),
    ptyProcessMetadataById: { ...state.ptyProcessMetadataById, [key]: entry }
  }
}

export function adoptTerminalProcessMetadata(
  state: TerminalProcessMetadataState,
  id: string,
  facts: TerminalProcessFacts,
  baseline: number
): Partial<TerminalProcessMetadataState> {
  const key = terminalProcessMetadataKey('local', id)
  const current = state.ptyProcessMetadataById[key]
  const same = Boolean(facts.incarnationId && facts.incarnationId === current?.incarnationId)
  if (
    (current?.retired && (same || !facts.incarnationId)) ||
    (!same && current && current.observationRevision > baseline)
  ) {
    return {}
  }
  const { incarnationId, shellPath, wslDistro } = facts
  return replaceEntry(state, key, {
    ...(same && current && !current.retired ? current : {}),
    observationRevision:
      same && current ? current.observationRevision : state.ptyProcessObservationRevision + 1,
    ...(incarnationId ? { incarnationId } : {}),
    ...(shellPath ? { shellPath } : {}),
    ...(wslDistro !== undefined ? { wslDistro } : {})
  })
}

export function retireTerminalProcessMetadata(
  state: TerminalProcessMetadataState,
  id: string,
  expected: Pick<TerminalProcessMetadata, 'incarnationId' | 'observationRevision'> | undefined
): Partial<TerminalProcessMetadataState> {
  const key = terminalProcessMetadataKey('local', id)
  const current = state.ptyProcessMetadataById[key]
  if (
    current?.retired ||
    (expected?.incarnationId
      ? current?.incarnationId !== expected.incarnationId
      : current?.observationRevision !== expected?.observationRevision)
  ) {
    return {}
  }
  return replaceEntry(state, key, {
    retired: true,
    observationRevision: current?.observationRevision ?? state.ptyProcessObservationRevision + 1,
    ...(current?.incarnationId ? { incarnationId: current.incarnationId } : {})
  })
}

export function observeTerminalProcessExit(
  state: TerminalProcessMetadataState,
  id: string,
  incarnationId?: string
): Partial<TerminalProcessMetadataState> {
  const key = terminalProcessMetadataKey('local', id)
  const current = state.ptyProcessMetadataById[key]
  if (incarnationId && current?.incarnationId === incarnationId) {
    return retireTerminalProcessMetadata(state, id, current)
  }
  const observationRevision = state.ptyProcessObservationRevision + 1
  return replaceEntry(
    state,
    key,
    current && !current.retired && incarnationId && current.incarnationId
      ? { ...current, observationRevision }
      : { retired: true, observationRevision, ...(incarnationId ? { incarnationId } : {}) }
  )
}

/** Saved shell/cwd remain launch intent; observed facts describe the live process. */
export function resolveTerminalProcessContext(
  facts: ReturnType<typeof readTerminalProcessMetadata>,
  fallback: { cwd?: string; shellOverride?: string | null }
) {
  const wslDistro = facts?.shellPath
    ? isWslShellName(facts.shellPath)
      ? typeof facts.wslDistro === 'string'
        ? facts.wslDistro
        : undefined
      : null
    : facts?.wslDistro
  return {
    cwd: fallback.cwd,
    shellOverride:
      facts?.shellPath ??
      (typeof wslDistro === 'string' ? 'wsl.exe' : (fallback.shellOverride ?? undefined)),
    ...(facts?.shellPath ? { shellPath: facts.shellPath } : {}),
    ...(facts && (facts.shellPath || wslDistro !== undefined) ? { wslDistro } : {})
  }
}

export function readTerminalTabShell(
  state: AppState,
  tab: Pick<TerminalTab, 'id' | 'shellOverride'>
): string | null | undefined {
  const layout = state.terminalLayoutsByTabId?.[tab.id]
  const live = state.ptyIdsByTabId?.[tab.id] ?? []
  const primary = layout ? resolvePrimaryLayoutPtyId(layout) : null
  const id = primary && live.includes(primary) ? primary : live[0]
  return (
    (id ? readTerminalProcessMetadata(state, 'local', id)?.shellPath : undefined) ??
    tab.shellOverride
  )
}
