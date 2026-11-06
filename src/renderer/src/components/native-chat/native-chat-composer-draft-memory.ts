import type { LoadBookkeeping } from './native-chat-composer-draft-load'
import type { AgentPickerRetainedSetup } from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import {
  currentDraftScope,
  captureLaunchDraftDestination,
  clearLaunchDraftSourcesForTests,
  nativeChatLaunchPromptDraftOwner,
  retainLaunchDraftSource
} from './native-chat-launch-draft-source'
import type { AgentPickerDraft } from '../../../../shared/agent-launch/picker/agent-launch-picker'
export {
  nativeChatLaunchPromptDraftOwner,
  nativeChatLaunchPromptDraftScopeKey,
  retainLaunchDraftSource
} from './native-chat-launch-draft-source'
import { sameNativeChatComposerDraftDocument } from './native-chat-composer-draft-comparison'
import type { NativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import { reconcileNativeChatStagedDraft } from './native-chat-draft-attachment-staging'
import {
  draftCustody,
  pruneNativeChatDraftSourcePaths,
  restoreNativeChatDraftSourcePaths
} from './native-chat-composer-draft-custody'
import { restoredImageChecks } from './native-chat-composer-draft-restored-images'
// Memory owns drafts; storage keeps a copy shared by the API and persistence modules.

import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftOwner,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

export type DraftRecord = StoredNativeChatComposerDraft & { readonly unsavedText?: string }

/** A write or removal handed to storage and not yet confirmed; `draft` is null for a removal. */
export type UnconfirmedDraftChange = {
  readonly draft: StoredNativeChatComposerDraft | null
  readonly at: number
}

export const records = new Map<string, DraftRecord>()
export type NativeChatDraftPosition = (
  | { at: 'start' | 'end' }
  | { at: 'selection'; from: number; to: number }
) & { target?: string; pending: boolean }
export const nativeChatDraftPositions = new WeakMap<
  NativeChatComposerDraft,
  NativeChatDraftPosition
>()

export function retireNativeChatDraftPosition(
  draft: NativeChatComposerDraft | undefined,
  target?: string
): void {
  const position = draft && nativeChatDraftPositions.get(draft)
  if (position && (target === undefined || position.target === target)) {
    position.pending = false
  }
}

/** Publish UI provenance with its exact value; only metadata-only replacements inherit it. */
export function installNativeChatDraftRecord(
  scope: string,
  draft?: DraftRecord,
  position?: NativeChatDraftPosition
): void {
  const previous = records.get(scope)
  if (
    previous &&
    draft &&
    previous.text === draft.text &&
    sameNativeChatComposerDraftDocument(previous.document, draft.document) &&
    !position
  ) {
    position = nativeChatDraftPositions.get(previous)
  } else {
    retireNativeChatDraftPosition(previous)
  }
  if (draft) {
    if (position) {
      nativeChatDraftPositions.set(draft, position)
    }
    records.set(scope, draft)
  } else {
    records.delete(scope)
  }
  pruneNativeChatDraftSourcePaths(scope, draft)
  reconcileNativeChatStagedDraft(scope, draft)
}

// Changed in memory with no write issued yet; a refused write comes back here for the next flush.
export const dirtyScopes = new Set<string>()
export const unconfirmed = new Map<string, UnconfirmedDraftChange>()
/** Source deletions wait for a write containing the moved draft, including later retries. */
export const deferredRemovals = new Map<string, { destinationScope: string; savedAt: number }>()
// Drafts whose last write storage refused; shown so the user knows they are held in memory only.
export const refusedScopes = new Set<string>()
export {
  NO_IMAGE_CHECKS,
  reconcileRestoredImageChecks,
  restoredImageChecks,
  restoredImageKey,
  type DraftImageCheck
} from './native-chat-composer-draft-restored-images'
export const scopeListeners = new Map<string, Set<() => void>>()

export type { DraftAppend, AppendBeforeLoad } from './native-chat-composer-draft-load'

export const load: LoadBookkeeping = {
  hydrated: false,
  appendSequence: 0,
  editedBeforeLoad: new Set(),
  appendsBeforeLoad: new Map(),
  deletionsBeforeLoad: []
}

let lastSavedAt = 0

/** Monotonic within a run, so drafts changed in the same millisecond still age in order. */
export function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  return lastSavedAt
}

export function notifyScope(scopeKey: string): void {
  scopeListeners.get(currentDraftScope(scopeKey))?.forEach((listener) => listener())
}

/** Setup options are authored input: the first change retains the setup, notifying its draft listeners. */
export function writeLaunchSetupOptions(
  scope: string,
  draft: AgentPickerDraft,
  slot = '',
  retained?: AgentPickerRetainedSetup
): void {
  const setup = retainLaunchDraftSource(scope)
  if (setup) {
    setup.options ??= new Map()
    const record = retained ??
      setup.options.get(slot) ?? {
        target: undefined,
        agent: draft.agent,
        source: undefined,
        draft,
        active: false
      }
    record.draft = draft
    setup.options.set(slot, record)
    notifyScope(scope)
  }
}

/** A local change not yet in storage, which a write from another window must not replace. */
export function hasLocalChange(scopeKey: string): boolean {
  return dirtyScopes.has(scopeKey) || unconfirmed.has(scopeKey)
}

export function hasUnsavedNativeChatComposerDraftChange(scopeKey: string): boolean {
  return hasLocalChange(currentDraftScope(scopeKey))
}

export function clearDraftMemoryForTests(): void {
  retireNativeChatComposerSubmissionsWhere(() => true)
  clearLaunchDraftSourcesForTests()
  resolveOwner = null
  for (const draft of records.values()) {
    retireNativeChatDraftPosition(draft)
  }
  records.clear()
  dirtyScopes.clear()
  unconfirmed.clear()
  deferredRemovals.clear()
  refusedScopes.clear()
  restoredImageChecks.clear()
  lastSavedAt = 0
  load.hydrated = false
  load.appendSequence = 0
  load.editedBeforeLoad.clear()
  load.appendsBeforeLoad.clear()
  load.deletionsBeforeLoad.length = 0
}

export type NativeChatDraftAppend =
  | NativeChatComposerDraftAddition
  | ((draft: NativeChatComposerDraft) => NativeChatComposerDraft)
export const appendListeners = new Map<
  string,
  Set<(addition: NativeChatDraftAppend, previous: NativeChatComposerDraft) => void>
>()
export function subscribeToNativeChatComposerDraftAppend(
  scope: string,
  listener: (addition: NativeChatDraftAppend, previous: NativeChatComposerDraft) => void
): () => void {
  const destination = captureLaunchDraftDestination(scope)
  scope = currentDraftScope(scope)
  const member = (addition: NativeChatDraftAppend, previous: NativeChatComposerDraft) =>
    listener(addition, previous)
  const scoped = appendListeners.get(scope) ?? new Set()
  appendListeners.set(scope, scoped)
  scoped.add(member)
  return () => {
    const current = appendListeners.get(destination?.scopeKey ?? scope)
    current?.delete(member)
    if (current?.size === 0) {
      appendListeners.delete(destination?.scopeKey ?? scope)
    }
  }
}

export function notifyDraftAppend(
  scope: string,
  addition: NativeChatDraftAppend,
  previous: NativeChatComposerDraft
): void {
  appendListeners.get(currentDraftScope(scope))?.forEach((listener) => listener(addition, previous))
}

export type NativeChatEditDraftDestination = { scopeKey: string; active: boolean }
export const ephemeralDrafts = new Map<string, NativeChatEditDraftDestination>()

export function captureNativeChatEditDraftDestination(
  scopeKey: string
): NativeChatEditDraftDestination | undefined {
  return captureLaunchDraftDestination(scopeKey) ?? ephemeralDrafts.get(scopeKey)
}

export function redirectNativeChatEditDraft(scopeKey: string, destination: string): void {
  const target = ephemeralDrafts.get(scopeKey)
  if (target) {
    target.scopeKey = destination
  }
}

export function isNativeChatEditDraft(scopeKey: string): boolean {
  return scopeKey.startsWith('queued-edit:')
}

/** Setup survives view close; only queued edits require an open editor lease. */
export function isNativeChatSetupDraft(scopeKey: string): boolean {
  return scopeKey.startsWith('agent-setup:')
}

export function isNativeChatMemoryOnlyDraft(scopeKey: string): boolean {
  return isNativeChatEditDraft(scopeKey) || isNativeChatSetupDraft(scopeKey)
}

export function closeNativeChatEditDraft(scopeKey: string): void {
  const target = ephemeralDrafts.get(scopeKey)
  if (target?.scopeKey === scopeKey) {
    target.active = false
  }
  ephemeralDrafts.delete(scopeKey)
  installNativeChatDraftRecord(scopeKey)
  notifyScope(scopeKey)
}

let resolveOwner: ((scopeKey: string) => NativeChatComposerDraftOwner | undefined) | null = null

/** Names the workspace a scope's chat belongs to, so a new draft can record its owner. */
export function setNativeChatComposerDraftOwnerResolver(
  resolver: (scopeKey: string) => NativeChatComposerDraftOwner | undefined
): void {
  resolveOwner = resolver
}

export function resolveNativeChatComposerDraftOwner(
  scopeKey: string
): NativeChatComposerDraftOwner | undefined {
  return nativeChatLaunchPromptDraftOwner(scopeKey) ?? resolveOwner?.(scopeKey)
}

export type DraftSubmission = {
  scopeKey: string
  draft: (NativeChatComposerDraft & { owner?: NativeChatComposerDraftOwner }) | undefined
  /** Provenance the submitted input carried, returned with it on recovery. */
  sourcePaths: readonly string[]
  stopObserving: () => void
}
export const submissions = new Map<string, Set<DraftSubmission>>()

/** Each send retains its own full source until a recipient owns it; removal revokes its write authority. */
export function captureNativeChatComposerSubmission(scopeKey: string) {
  scopeKey = currentDraftScope(scopeKey)
  const current = records.get(scopeKey)
  const submission: DraftSubmission = {
    scopeKey,
    draft: {
      ...(current ?? { text: '', images: [] }),
      owner: current?.owner ?? resolveNativeChatComposerDraftOwner(scopeKey)
    },
    sourcePaths: [...(draftCustody.get(scopeKey)?.sourcePaths ?? [])],
    stopObserving: () => {}
  }
  const scoped = submissions.get(scopeKey) ?? new Set<DraftSubmission>()
  scoped.add(submission)
  submissions.set(scopeKey, scoped)
  return submission
}

/** `recover` returns the submission's provenance with it, before its input is given back. */
export function releaseNativeChatComposerSubmission(
  scopeKey: string,
  submission: DraftSubmission,
  recover = false
) {
  scopeKey = submission.scopeKey
  const draft = submission.draft
  if (recover && draft) {
    restoreNativeChatDraftSourcePaths(scopeKey, submission.sourcePaths)
  }
  submission.draft = undefined
  submission.stopObserving()
  submission.stopObserving = () => {}
  const scoped = submissions.get(scopeKey)
  scoped?.delete(submission)
  if (scoped?.size === 0) {
    submissions.delete(scopeKey)
  }
  return draft
}

export function retireNativeChatComposerSubmissionsWhere(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): void {
  for (const [scopeKey, scoped] of submissions) {
    for (const submission of scoped) {
      if (matches(scopeKey, submission.draft ? { ...submission.draft, savedAt: 0 } : undefined)) {
        releaseNativeChatComposerSubmission(scopeKey, submission)
      }
    }
  }
}
