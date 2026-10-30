import {
  transitionSession,
  type PreviewSession,
  type PreviewInputBinding
} from './preview-terminal-input-source'
import { snapshotResult, outputAfterSnapshot, releaseGate } from './preview-terminal-snapshot'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { takeCurrentTerminalDeliveryCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import type { RemoteRuntimeMultiplexedTerminal } from '@/runtime/remote-runtime-terminal-multiplexer-types'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'

const CONNECT_TIMEOUT_MS = 15_000
const UNAVAILABLE: TerminalPreviewConnectResult = { snapshot: null, replay: [] }

export function createPreviewTerminalSessionLifetime(
  sessions: Map<string, PreviewSession>,
  emit: (payload: TerminalPreviewDataPayload) => void
) {
  function closeSession(
    ptyId: string,
    session: PreviewSession,
    unavailable = false,
    ended = false
  ): void {
    const retired: { stream: RemoteRuntimeMultiplexedTerminal | null; releases: (() => void)[] } = {
      stream: null,
      releases: []
    }
    let failure: unknown
    try {
      transitionSession(
        session,
        null,
        () => {
          session.closed = true
          session.ended ||= ended
          if (!ended && sessions.get(ptyId) === session) {
            sessions.delete(ptyId)
          }
          retired.stream = session.stream
          session.stream = null
          retired.releases = [
            ...session.credits.splice(0),
            ...(session.gate?.splice(0).map((chunk) => chunk.release) ?? [])
          ]
          session.gate = null
        },
        unavailable
      )
    } catch (error) {
      failure = error
    }
    for (const cleanup of [...retired.releases, () => retired.stream?.close()]) {
      try {
        cleanup()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) {
      throw failure
    }
  }

  function openSession(
    ptyId: string,
    environmentId: string,
    handle: string,
    binding?: PreviewInputBinding
  ) {
    const multiplexer = getRemoteRuntimeTerminalMultiplexer(environmentId)
    const session: PreviewSession = {
      endpoint: {
        handle,
        incarnationId: null,
        environmentId,
        revision: getRuntimeEnvironmentRevision(environmentId)
      },
      transition: null,
      bindings: new Set(),
      stream: null,
      opening: null,
      ended: false,
      closed: false,
      gate: [],
      snapshotSeq: undefined,
      credits: [],
      grid: null
    }
    sessions.set(ptyId, session)
    const current = (): boolean =>
      !session.closed && !session.ended && sessions.get(ptyId) === session
    binding?.attach(session)
    let initialized = false
    const opening = new Promise<TerminalPreviewConnectResult>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        try {
          closeSession(ptyId, session)
        } finally {
          finish(UNAVAILABLE)
        }
      }, CONNECT_TIMEOUT_MS)
      function finish(result: TerminalPreviewConnectResult): void {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          session.opening = null
          resolve(result)
        }
      }
      const markEnded = (unavailable: boolean): void => {
        try {
          closeSession(ptyId, session, unavailable, true)
        } finally {
          finish(UNAVAILABLE)
        }
        if (initialized) {
          emit({ type: 'resync', ptyId })
        }
      }
      void multiplexer
        .subscribeTerminal({
          terminal: handle,
          // Why a preview-only id: its viewport claim must release with this stream, not a pane's.
          client: { id: `dashboard-preview:${createBrowserUuid()}`, type: 'desktop' },
          callbacks: {
            onSubscribeAcknowledged: (result) => {
              if (!current() || !result?.incarnationId) {
                return
              }
              const endpoint = { ...session.endpoint, incarnationId: result.incarnationId }
              transitionSession(session, endpoint, () => {
                session.endpoint = endpoint
              })
            },
            onSnapshot: (data, meta) => {
              if (!current()) {
                return
              }
              if (initialized) {
                // A host-pushed recovery image follows dropped output; repaint through a fresh request.
                emit({ type: 'resync', ptyId })
                return
              }
              initialized = true
              let result = UNAVAILABLE
              try {
                const replay = releaseGate(session, meta?.seq)
                if (current()) {
                  result = snapshotResult(session, data, meta, replay)
                }
              } finally {
                finish(result)
              }
            },
            onData: (data, meta) => {
              if (!current()) {
                return
              }
              const noCredit = (): void => {}
              if (session.gate) {
                session.gate.push({
                  data,
                  meta,
                  release: takeCurrentTerminalDeliveryCredit() ?? noCredit
                })
                return
              }
              const uncovered = outputAfterSnapshot(data, meta, session.snapshotSeq)
              if (uncovered) {
                // Why: hold the host's credit until the preview parses the chunk, like a pane does.
                session.credits.push(takeCurrentTerminalDeliveryCredit() ?? noCredit)
                emit({ type: 'data', ptyId, data: uncovered, bytes: uncovered.length })
              }
            },
            onFitOverrideChanged: (event) => {
              if (!current()) {
                return
              }
              if (event.cols !== session.grid?.cols || event.rows !== session.grid?.rows) {
                emit({ type: 'resync', ptyId })
              }
            },
            onEnd: () => {
              if (current()) {
                markEnded(true)
              }
            },
            onError: () => {
              if (current()) {
                markEnded(false)
              }
            },
            onTransportClose: (event) => {
              if (!current()) {
                return
              }
              const releases: (() => void)[] = []
              let adopted = false
              try {
                transitionSession(
                  session,
                  event.recoverable ? session.endpoint : null,
                  () => {
                    session.ended ||= !event.recoverable
                    if (sessions.get(ptyId) === session) {
                      sessions.delete(ptyId)
                    }
                    session.stream = null
                    releases.push(
                      ...session.credits.splice(0),
                      ...(session.gate?.splice(0).map((chunk) => chunk.release) ?? [])
                    )
                    session.gate = null
                    adopted = true
                  },
                  !event.recoverable,
                  event.recoverable
                )
              } finally {
                try {
                  let failure: unknown
                  for (const release of releases) {
                    try {
                      release()
                    } catch (error) {
                      failure ??= error
                    }
                  }
                  if (failure !== undefined) {
                    throw failure
                  }
                } finally {
                  finish(UNAVAILABLE)
                }
              }
              if (adopted && initialized && !session.closed && !sessions.has(ptyId)) {
                emit({ type: 'resync', ptyId })
              }
            }
          }
        })
        .then(
          (stream) => {
            if (
              session.closed ||
              session.ended ||
              sessions.get(ptyId) !== session ||
              resolveContinuedRuntimeEnvironmentRevision(
                environmentId,
                session.endpoint.revision
              ) !== getRuntimeEnvironmentRevision(environmentId)
            ) {
              stream.close()
              return
            }
            session.stream = stream
          },
          () => {
            try {
              closeSession(ptyId, session)
            } finally {
              finish(UNAVAILABLE)
            }
          }
        )
    })
    if (!session.closed && !session.ended && !initialized) {
      session.opening = opening
    }
    return opening
  }

  return { openSession, closeSession }
}
