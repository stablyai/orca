import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged,
  isRuntimeEnvironmentContinuationPending,
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import {
  createStructuredSessionSelectionController,
  type StructuredSessionSelectionController
} from '../../../shared/structured-agent-session-selection-operations'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AgentType } from '../../../shared/agent-status-types'
import { enqueueSessionOptionSettingsWrite } from '@/components/native-chat/native-chat-session-option-settings-write'

type SelectionCatalogState = { runtimeEnvironmentCatalogHydrated: boolean }
type SelectionCatalogStore = {
  read: () => SelectionCatalogState
  subscribe: (listener: (state: SelectionCatalogState) => void) => () => void
}
let catalogStore: SelectionCatalogStore | undefined

// Cleanup imports from store slices must not construct the app store.
export function registerStructuredSelectionCatalogStore(store: SelectionCatalogStore): () => void {
  const previous = catalogStore
  catalogStore = store
  return () => {
    catalogStore = previous
  }
}

export function structuredSessionSelectionAuthority(target: RuntimeClientTarget): string {
  return target.kind === 'local'
    ? 'local'
    : JSON.stringify([
        getRuntimeEnvironmentRevision(target.environmentId),
        getRuntimeEnvironmentConnectionGeneration(target.environmentId)
      ])
}
type SelectionRequestOptions = { expectedEnvironmentPairingRevision?: number }
type SessionSelectionController = StructuredSessionSelectionController & {
  isCurrent(): boolean
  request<T>(perform: (options: SelectionRequestOptions) => Promise<T>): Promise<T>
}
const controllers = new Map<
  string,
  {
    sessionId: string
    host: string
    controller: SessionSelectionController
    originalRevision: () => number | undefined
    release: () => void
  }
>()

/** Launch and attached views share the same sender on the execution host's logical chat. */
export function structuredSessionSelectionController(
  target: RuntimeClientTarget,
  sessionId: string,
  agent: AgentType
) {
  const host = target.kind === 'local' ? 'local' : target.environmentId
  const key = JSON.stringify([host, sessionId, agent])
  const existing = controllers.get(key)
  if (existing) {
    return existing.controller
  }
  const store = target.kind === 'environment' ? catalogStore : undefined
  if (target.kind === 'environment' && !store) {
    throw new Error('Selection catalog store must be registered before remote acquisition.')
  }
  let originalRevision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  const isCurrent = () => controllers.get(key)?.controller === controller
  const controller: SessionSelectionController = {
    ...createStructuredSessionSelectionController((picks) => {
      void controller
        .request((options) => {
          const mutation = { type: 'apply-picks', agent, picks } as const
          return options.expectedEnvironmentPairingRevision === undefined
            ? enqueueSessionOptionSettingsWrite(target, mutation)
            : enqueueSessionOptionSettingsWrite(target, mutation, options)
        })
        .catch(() => undefined)
    }, isCurrent),
    isCurrent,
    async request(perform) {
      if (!isCurrent()) {
        throw new Error('Conversation selection owner retired.')
      }
      // An absent original pairing cannot confer authority over a later registration.
      if (target.kind === 'environment' && originalRevision === undefined) {
        throw new Error('Conversation host pairing unavailable.')
      }
      const result = await perform(
        originalRevision === undefined
          ? {}
          : {
              expectedEnvironmentPairingRevision: resolveContinuedRuntimeEnvironmentRevision(
                host,
                originalRevision
              )
            }
      )
      if (!isCurrent()) {
        throw new Error('Conversation selection owner retired.')
      }
      return result
    }
  }
  let release = () => {}
  controllers.set(key, {
    sessionId,
    host,
    controller,
    originalRevision: () => originalRevision,
    release: () => release()
  })
  if (store && !store.read().runtimeEnvironmentCatalogHydrated) {
    release = store.subscribe((state) => {
      if (state.runtimeEnvironmentCatalogHydrated) {
        originalRevision = getRuntimeEnvironmentRevision(host)
        release()
      }
    })
  }
  return controller
}

function endSelection(key: string): void {
  const entry = controllers.get(key)
  if (entry) {
    controllers.delete(key)
    entry.release()
    entry.controller.abandon()
  }
}

/** Closing/purging a chat explicitly ends its transient operations, including ambiguous writes. */
export function forgetStructuredSessionSelection(
  sessionId: string,
  target?: RuntimeClientTarget
): void {
  const host = target?.kind === 'local' ? 'local' : target?.environmentId
  for (const [key, entry] of controllers) {
    if (entry.sessionId === sessionId && (host === undefined || entry.host === host)) {
      endSelection(key)
    }
  }
}

const retireHosts = (ids: readonly string[]) => {
  for (const [key, entry] of controllers) {
    if (ids.includes(entry.host)) {
      endSelection(key)
    }
  }
}
onRuntimeEnvironmentsRetired(retireHosts)

onRuntimeEnvironmentRevisionsChanged((ids) => {
  for (const [key, entry] of controllers) {
    if (!ids.includes(entry.host)) {
      continue
    }
    const original = entry.originalRevision()
    const continued =
      original === undefined
        ? undefined
        : resolveContinuedRuntimeEnvironmentRevision(entry.host, original)
    if (
      continued !== getRuntimeEnvironmentRevision(entry.host) &&
      !isRuntimeEnvironmentContinuationPending(entry.host, continued)
    ) {
      endSelection(key)
    }
  }
})
