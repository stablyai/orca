import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { resolveRepositoryAddScriptPrompt } from '@/runtime/repository-add-script-execution'
import type {
  RepositoryAddScriptPreview,
  RepositoryAddScriptPromptDecision
} from '../../../shared/repository-add-script-types'

/** Receives the decision once the prompt has left the screen; owns routing and result UI. */
export type RepositoryAddScriptPromptResolver = (
  decision: RepositoryAddScriptPromptDecision,
  preview: RepositoryAddScriptPreview
) => void

export type RepositoryAddScriptPromptEntry = {
  preview: RepositoryAddScriptPreview
  onDecision: RepositoryAddScriptPromptResolver
}

export type RepositoryAddScriptPromptState = {
  current: RepositoryAddScriptPromptEntry | null
  offerRepositoryAddScript: (
    preview: RepositoryAddScriptPreview,
    onDecision?: RepositoryAddScriptPromptResolver
  ) => void
  /** Pops the visible prompt and reveals the next one before the decision runs. */
  takeRepositoryAddScriptPrompt: (
    decision: RepositoryAddScriptPromptDecision
  ) => RepositoryAddScriptPromptEntry | null
}

// Why: a prompt can take the visible slot the instant this one decides, either from the queue or
// from a registration that fills the emptied slot. A second click aimed at the previous prompt
// would otherwise run a script the user never saw asked about.
const INTER_PROMPT_ACTION_GUARD_MS = 350

const defaultOnDecision: RepositoryAddScriptPromptResolver = (decision, preview) => {
  void resolveRepositoryAddScriptPrompt(preview, decision)
}

export type RepositoryAddScriptPromptStore = UseBoundStore<StoreApi<RepositoryAddScriptPromptState>>

export function createRepositoryAddScriptPromptStore(
  defaultResolver: RepositoryAddScriptPromptResolver = defaultOnDecision
): RepositoryAddScriptPromptStore {
  const queued: RepositoryAddScriptPromptEntry[] = []
  // The token is shown or waiting once; an offer repeated before it leaves must not prompt twice.
  const pendingTokens = new Set<string>()
  let actionAllowedAt = 0

  return create<RepositoryAddScriptPromptState>()((set, get) => ({
    current: null,

    offerRepositoryAddScript: (preview, onDecision = defaultResolver) => {
      if (pendingTokens.has(preview.token)) {
        return
      }
      pendingTokens.add(preview.token)
      const entry = { preview, onDecision }
      if (get().current) {
        queued.push(entry)
        return
      }
      set({ current: entry })
    },

    takeRepositoryAddScriptPrompt: (decision) => {
      const current = get().current
      if (!current || Date.now() < actionAllowedAt) {
        return null
      }
      // Why: advance before the callback and the return so a re-entrant read sees the next entry.
      pendingTokens.delete(current.preview.token)
      const next = queued.shift() ?? null
      set({ current: next })
      // Why: a prompt offered into the emptied slot within the same gesture must not be
      // actionable by the second click of a double click aimed at the one just dismissed.
      actionAllowedAt = Date.now() + INTER_PROMPT_ACTION_GUARD_MS
      current.onDecision(decision, current.preview)
      return current
    }
  }))
}

export const useRepositoryAddScriptPromptStore = createRepositoryAddScriptPromptStore()

/** The registration flow's entry point; the default decision runs the shared executor. */
export function offerRepositoryAddScript(
  preview: RepositoryAddScriptPreview,
  onDecision?: RepositoryAddScriptPromptResolver
): void {
  useRepositoryAddScriptPromptStore.getState().offerRepositoryAddScript(preview, onDecision)
}

export function takeRepositoryAddScriptPrompt(
  decision: RepositoryAddScriptPromptDecision
): RepositoryAddScriptPromptEntry | null {
  return useRepositoryAddScriptPromptStore.getState().takeRepositoryAddScriptPrompt(decision)
}
