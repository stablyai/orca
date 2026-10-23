import { useAppStore } from '@/store'
import { ensurePtyDispatcher } from './pty-dispatcher'
import {
  adoptTerminalProcessMetadata,
  readTerminalProcessMetadata,
  retireTerminalProcessMetadata,
  resolveTerminalProcessContext,
  type TerminalProcessFacts
} from '@/store/terminals/terminal-process-metadata'

function describe<T>(action: () => T): T | undefined {
  try {
    return action()
  } catch (error) {
    console.warn('[pty] could not update process description', error)
    return undefined
  }
}

/** Pending requests retain only the observation clock, never the payload map. */
export function captureLocalPtyProcessDescription(isLocal: boolean) {
  const baseline = isLocal
    ? describe(() => {
        ensurePtyDispatcher()
        return useAppStore.getState().ptyProcessObservationRevision
      })
    : undefined
  return (facts: TerminalProcessFacts & { id: string }): void => {
    if (baseline !== undefined) {
      describe(() =>
        useAppStore.setState((state) =>
          adoptTerminalProcessMetadata(state, facts.id, facts, baseline)
        )
      )
    }
  }
}

export function createIpcPtyProcessDescription(
  isLocal: boolean,
  getId: () => string | null,
  onChange: () => void,
  fallback: { cwd?: string; shellOverride?: string }
) {
  const shellOverride = fallback.shellOverride
  type Entry = ReturnType<typeof readTerminalProcessMetadata>
  let process: {
    metadata: Entry
    identity?: Pick<NonNullable<Entry>, 'incarnationId' | 'observationRevision'>
  } = { metadata: undefined }
  let unsubscribe: (() => void) | undefined
  const detach = () => {
    unsubscribe?.()
    unsubscribe = undefined
  }
  return {
    capture: () => captureLocalPtyProcessDescription(isLocal),
    getContext: () =>
      isLocal
        ? resolveTerminalProcessContext(process.metadata, { cwd: fallback.cwd, shellOverride })
        : null,
    detach,
    captureRetirement() {
      const id = getId(),
        captured = process
      return () => {
        if (isLocal && id) {
          describe(() =>
            useAppStore.setState((state) =>
              retireTerminalProcessMetadata(state, id, captured.identity)
            )
          )
        }
      }
    },
    bind(incarnationId?: string) {
      detach()
      const id = getId()
      const captured: typeof process = { metadata: undefined }
      process = captured
      const refresh = (initial = false) => {
        let next =
          isLocal && id
            ? readTerminalProcessMetadata(useAppStore.getState(), 'local', id)
            : undefined
        const identity = captured.identity
        if (
          next &&
          ((incarnationId && next.incarnationId !== incarnationId) ||
            (identity &&
              (identity.incarnationId
                ? next.incarnationId !== identity.incarnationId
                : next.observationRevision !== identity.observationRevision)))
        ) {
          next = undefined
        }
        if (next) {
          captured.identity ??= {
            incarnationId: next.incarnationId,
            observationRevision: next.observationRevision
          }
        }
        if (initial || captured.metadata !== next) {
          captured.metadata = next
          onChange()
        }
      }
      describe(() => refresh(true))
      if (process === captured && getId() === id) {
        describe(() => {
          unsubscribe = useAppStore.subscribe(() => describe(refresh))
        })
      }
    },
    hydrate(
      id: string,
      publish: ReturnType<typeof captureLocalPtyProcessDescription>,
      isCurrent: () => boolean
    ) {
      if (!isLocal || process.metadata?.shellPath || process.metadata?.wslDistro !== undefined) {
        return
      }
      const captured = process
      describe(() => {
        void window.api.pty
          .listSessions?.({ connectionId: null })
          .then((sessions) => {
            if (isCurrent() && process === captured) {
              const facts = sessions.find((row) => row.id === id && !row.exiting)
              if (facts) {
                publish(facts)
              }
            }
          })
          .catch((error) => console.warn('[pty] could not refresh process description', error))
      })
    }
  }
}
