import {
  createPtyInputSourceBinding,
  type PtyInputSourceTransition
} from '../terminal-pane/pty-input-source'
import { isSameRemoteRuntimeInputEndpoint } from '../terminal-pane/remote-runtime-recovery-input-hold'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeMultiplexedTerminalCallbacks
} from '@/runtime/remote-runtime-terminal-multiplexer-types'
import type { TerminalPreviewConnectResult } from '../../../../shared/terminal-preview'

type OutputMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onData']>[1]
type HeldChunk = { data: string; meta: OutputMeta; release: () => void }

export type PreviewInputEndpoint = {
  handle: string
  incarnationId: string | null
  environmentId: string
  revision: number | undefined
}

function sameRuntime(a: PreviewInputEndpoint, b: PreviewInputEndpoint): boolean {
  return (
    a.environmentId === b.environmentId &&
    resolveContinuedRuntimeEnvironmentRevision(a.environmentId, a.revision) === b.revision
  )
}

export type PreviewInputBinding = {
  source: ReturnType<typeof createPtyInputSourceBinding<PreviewInputEndpoint>>
  reserve: (
    next: PreviewSession | null,
    endpoint: PreviewInputEndpoint | null,
    unavailable: boolean
  ) => BindingTransition
  attach: (next: PreviewSession) => void
  invalidate: () => void
  dispose: () => boolean
}
type BindingTransition = {
  binding: PreviewInputBinding
  source: PtyInputSourceTransition
  install: (adopted: boolean) => void
}
export type SessionTransition = {
  endpoint: PreviewInputEndpoint | null
  bindings: BindingTransition[]
}

export function createPreviewInputBinding(ptyId: string): PreviewInputBinding {
  let session: PreviewSession | null = null
  const source = createPtyInputSourceBinding<PreviewInputEndpoint>({
    same: (a, b) => sameRuntime(a, b) && isSameRemoteRuntimeInputEndpoint(a, b),
    unavailable: (a, b) =>
      !sameRuntime(a, b) ||
      (a.handle === b.handle &&
        a.incarnationId !== null &&
        b.incarnationId !== null &&
        a.incarnationId !== b.incarnationId),
    refine: (a, b) => ({ ...b, incarnationId: b.incarnationId ?? a.incarnationId }),
    create: (endpoint, isCurrent) => {
      const current = (): boolean => {
        const represented = endpoint()
        if (
          !isCurrent() ||
          !session ||
          session.closed ||
          session.ended ||
          represented.environmentId !== session.endpoint.environmentId ||
          !isSameRemoteRuntimeInputEndpoint(represented, session.endpoint)
        ) {
          return false
        }
        const revision = getRuntimeEnvironmentRevision(represented.environmentId)
        if (session.endpoint.revision !== revision) {
          return false
        }
        const continued =
          represented.revision === undefined
            ? revision
            : resolveContinuedRuntimeEnvironmentRevision(
                represented.environmentId,
                represented.revision
              )
        return continued === session.endpoint.revision && continued === revision
      }
      const write = (data: string): boolean =>
        current() && (session?.stream?.sendInput(data) ?? false)
      return { ptyId, isCurrent: current, sendInput: write, sendInputImmediate: write }
    }
  })
  const binding: PreviewInputBinding = {
    source,
    reserve(
      next: PreviewSession | null,
      endpoint: PreviewInputEndpoint | null,
      unavailable: boolean
    ): BindingTransition {
      const previous = session
      const pending = source.begin(endpoint, unavailable)
      return {
        binding,
        source: pending,
        install: (adopted) => {
          if (!pending.owns()) {
            return
          }
          previous?.bindings.delete(binding)
          session = adopted ? next : null
          if (session) {
            session.bindings.add(binding)
          }
          pending.install(adopted)
        }
      }
    },
    attach(next: PreviewSession): void {
      if (next.closed || next.ended) {
        return
      }
      const active = next.transition
      if (active?.bindings.some((part) => part.binding === binding && part.source.owns())) {
        return
      }
      const pending = binding.reserve(next, active ? active.endpoint : next.endpoint, false)
      next.bindings.add(binding)
      if (active) {
        active.bindings.push(pending)
      }
      pending.source.settle()
      pending.source.retire()
      if (!active) {
        pending.install(true)
        pending.source.notify()
      }
    },
    invalidate: () => source.invalidate(),
    dispose: () => {
      const pending = binding.reserve(null, null, false)
      pending.source.settle()
      pending.source.retire()
      pending.install(true)
      pending.source.notify()
      return pending.source.owns()
    }
  }
  return binding
}

export function transitionSession(
  session: PreviewSession,
  endpoint: PreviewInputEndpoint | null,
  adopt: () => void,
  unavailable = false,
  revoke = false
): void {
  const operation: SessionTransition = { endpoint, bindings: [] }
  session.transition = operation
  const owns = (): boolean => session.transition === operation
  // Retire every contradicted record before the first owner is called.
  operation.bindings = [...session.bindings].map((binding) =>
    binding.reserve(endpoint ? session : null, endpoint, unavailable)
  )
  for (const part of [...operation.bindings]) {
    if (!owns()) {
      break
    }
    part.source.settle()
    if (revoke && part.source.owns()) {
      part.binding.invalidate()
    }
  }
  if (!owns()) {
    return
  }
  for (const part of operation.bindings) {
    part.source.retire()
  }
  let adopted = false
  try {
    adopt()
    adopted = true
  } finally {
    if (owns()) {
      for (const part of operation.bindings) {
        part.install(adopted)
      }
      // A join during notification sees the complete adopted route.
      session.transition = null
      for (const part of operation.bindings) {
        part.source.notify()
      }
    }
  }
}

export type PreviewSession = {
  endpoint: PreviewInputEndpoint
  transition: SessionTransition | null
  bindings: Set<PreviewInputBinding>
  stream: RemoteRuntimeMultiplexedTerminal | null
  /** The pending first connect; a refresh issued before it lands shares it. */
  opening: Promise<TerminalPreviewConnectResult> | null
  /** The host ended the stream; the pane is gone or unreachable, never "exited" by guess. */
  ended: boolean
  closed: boolean
  /** Live chunks held while a snapshot is in flight, so the boundary can drop covered bytes. */
  gate: HeldChunk[] | null
  /** Output high-water of the applied snapshot; a tagged request still forwards covered chunks. */
  snapshotSeq: number | undefined
  /** Transport credit per emitted chunk, returned in order as the preview parses them. */
  credits: (() => void)[]
  grid: { cols: number; rows: number } | null
}
