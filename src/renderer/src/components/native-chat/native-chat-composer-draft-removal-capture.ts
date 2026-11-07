import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import {
  records,
  submissions,
  ephemeralDrafts,
  deferredRemovals,
  load
} from './native-chat-composer-draft-memory'
import {
  nativeChatComposerDraftOperations,
  nativeChatComposerDraftOperationScopes,
  savedNativeChatComposerDraftForm,
  nativeChatComposerDraftForeignRead
} from './native-chat-composer-draft-persistence'
import { captureNativeChatPendingAttachments } from './native-chat-pending-attachment-cache'
import {
  parseNativeChatComposerDraftOwner,
  parseStoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import { nativeChatRemovalJournalScope } from './native-chat-composer-draft-removal-journal'
import { nativeChatComposerDraftJournalReplayKey } from './native-chat-composer-draft-journal'
import type { NativeChatDraftLoadAttempt } from './native-chat-composer-draft-load-attempt'
import {
  observeNativeChatDraftReturn,
  releaseNativeChatDraftReturn,
  type NativeChatDraftReturnSource,
  type NativeChatDraftReturnEvent
} from './native-chat-draft-return-products'
import { captureNativeChatStagedRemoval } from './native-chat-draft-attachment-staging'

export function nativeChatDraftValueKey(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}

export function captureNativeChatDraftRemovalScopes(
  saved: ReadonlyMap<string, unknown>,
  journal: readonly unknown[] | null,
  submissionsOnly = false,
  attempts: ReadonlySet<NativeChatDraftLoadAttempt> = new Set(load.attempt ? [load.attempt] : [])
) {
  const keys = new Map<unknown, string>()
  const parsed = new Map<unknown, string | undefined>()
  const key = (value: unknown) => {
    if (!keys.has(value)) {
      keys.set(value, nativeChatDraftValueKey(value))
    }
    return keys.get(value)!
  }
  const parsedKey = (value: unknown) => {
    if (!parsed.has(value)) {
      const draft = parseStoredNativeChatComposerDraft(value)
      parsed.set(value, draft ? key(draft) : undefined)
    }
    return parsed.get(value)
  }
  const pending: ReturnType<typeof captureNativeChatPendingAttachments> = submissionsOnly
    ? new Map()
    : captureNativeChatPendingAttachments()
  const journalByScope = new Map<string, unknown[]>()
  for (const entry of submissionsOnly ? [] : (journal ?? [])) {
    const scope = nativeChatRemovalJournalScope(entry)
    if (scope) {
      const held = journalByScope.get(scope) ?? []
      held.push(entry)
      journalByScope.set(scope, held)
    }
  }
  const scopes = submissionsOnly
    ? new Set(submissions.keys())
    : new Set([
        ...saved.keys(),
        ...records.keys(),
        ...submissions.keys(),
        ...pending.keys(),
        ...ephemeralDrafts.keys(),
        ...[...ephemeralDrafts.values()].flatMap((edit) =>
          edit.returning ? [edit.returning.destination] : []
        ),
        ...nativeChatComposerDraftOperationScopes(),
        ...journalByScope.keys(),
        ...load.appendsBeforeLoad.keys()
      ])
  const transfersByDestination = new Map<
    string,
    [string, typeof deferredRemovals extends Map<string, infer T> ? T : never][]
  >()
  for (const [scope, transfer] of submissionsOnly ? [] : deferredRemovals) {
    const held = transfersByDestination.get(transfer.destinationScope) ?? []
    held.push([scope, transfer])
    transfersByDestination.set(transfer.destinationScope, held)
  }
  const pastesByScope = new Map<string, [string, { scopeKey: string; text: string }][]>()
  for (const [id, operation] of submissionsOnly ? [] : nativeChatPastedTextOperations) {
    const held = pastesByScope.get(operation.scopeKey) ?? []
    held.push([id, operation])
    pastesByScope.set(operation.scopeKey, held)
  }
  return new Map(
    [...scopes].map((scope) => {
      const record = records.get(scope)
      const edit = submissionsOnly ? undefined : ephemeralDrafts.get(scope)
      const operations = submissionsOnly
        ? []
        : [
            ...new Set([
              ...nativeChatComposerDraftOperations(scope),
              ...(load.appendsBeforeLoad.get(scope) ?? [])
            ])
          ]
      const expected = new Set<string>([key(saved.get(scope))])
      if (record && !submissionsOnly) {
        expected.add(key(savedNativeChatComposerDraftForm(record)))
      }
      for (const operation of operations) {
        if ('draft' in operation) {
          expected.add(key(operation.draft))
        }
      }
      const entries = journalByScope.get(scope) ?? []
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && 'draft' in entry && entry.draft) {
          expected.add(key(entry.draft))
        }
      }
      const loaded = new Set<string>()
      const censusRoots = new Set<string>()
      for (const value of expected) {
        if (value !== 'undefined') {
          const parsed = parseStoredNativeChatComposerDraft(JSON.parse(value))
          if (parsed) {
            censusRoots.add(value)
            loaded.add(key(parsed))
          }
        }
      }
      return [
        scope,
        {
          scope,
          record,
          edit,
          destination: edit?.returning?.destination ?? scope,
          saved: saved.get(scope),
          operations,
          operationSet: new Set(operations),
          expected,
          loaded,
          censusRoots,
          predecessors: operations.flatMap((operation) => {
            const applied = operation.applied
            if (!applied) {
              return []
            }
            const loaded = parsedKey(applied.input)
            return [
              {
                input: key(applied.input),
                output: key(applied.output),
                loaded
              }
            ]
          }),
          journal: new Set(entries.map(nativeChatComposerDraftJournalReplayKey)),
          submissions: [...(submissions.get(scope) ?? [])].map((submission) => ({
            submission,
            destination: submission.scopeKey
          })),
          pending: pending.get(scope),
          staged: captureNativeChatStagedRemoval(
            submissionsOnly ? '' : scope,
            pending.get(scope)?.chips
          ),
          foreignRead: nativeChatComposerDraftForeignRead(scope),
          attempts,
          derivedJournal: [] as unknown[],
          transfers: transfersByDestination.get(scope) ?? [],
          pastes: pastesByScope.get(scope) ?? [],
          journalHosts: new Set(
            entries.flatMap((entry) => {
              const draft =
                entry && typeof entry === 'object' && 'draft' in entry
                  ? draftOwner(entry.draft)
                  : undefined
              return draft ? [draft.executionHostId] : []
            })
          )
        }
      ]
    })
  )
}

export type NativeChatDraftRemovalScope =
  ReturnType<typeof captureNativeChatDraftRemovalScopes> extends Map<string, infer T> ? T : never

export function observeNativeChatDraftRemovalReturns(
  scopes: ReadonlyMap<string, NativeChatDraftRemovalScope>
) {
  const streams = new Map<
    string,
    {
      events: NativeChatDraftReturnEvent[]
      sources: Map<NativeChatDraftReturnSource, string>
      watch: (source: NativeChatDraftReturnSource, scope: string) => void
      stop: () => void
      release: () => void
    }
  >()
  for (const captured of scopes.values()) {
    let stream = streams.get(captured.destination)
    if (!stream) {
      const dispose: (() => void)[] = []
      const events: NativeChatDraftReturnEvent[] = []
      const sources = new Map<NativeChatDraftReturnSource, string>()
      const observe = (event: NativeChatDraftReturnEvent) => events.push(event)
      stream = {
        events,
        sources,
        watch: (source, scope) => {
          sources.set(source, scope)
          dispose.push(observeNativeChatDraftReturn(source, observe))
        },
        stop: () => {
          dispose.forEach((stop) => stop())
          dispose.length = 0
        },
        release: () => {
          events.forEach(releaseNativeChatDraftReturn)
          events.length = 0
          sources.clear()
        }
      }
      streams.set(captured.destination, stream)
    }
    const watch = stream.watch
    for (const { submission, destination } of captured.submissions) {
      watch(submission, destination)
    }
    for (const chip of captured.pending?.chips ?? []) {
      watch(chip, captured.scope)
    }
    for (const [, paste] of captured.pastes) {
      watch(paste, captured.scope)
    }
    if (captured.edit?.returning) {
      watch(captured.edit.returning, captured.scope)
    }
  }
  return {
    streams,
    dispose: () =>
      streams.forEach((stream) => {
        stream.stop()
        stream.release()
      })
  }
}

function draftOwner(value: unknown) {
  return value && typeof value === 'object' && 'owner' in value
    ? parseNativeChatComposerDraftOwner(value.owner)
    : undefined
}

export function nativeChatDraftRemovalHosts(
  captured: NativeChatDraftRemovalScope
): ReadonlySet<string> {
  const hosts = new Set<string>(captured.journalHosts)
  const add = (value: { owner?: { executionHostId: string } } | undefined | null) => {
    if (value?.owner) {
      hosts.add(value.owner.executionHostId)
    }
  }
  add(captured.record)
  for (const operation of captured.operations) {
    if ('draft' in operation) {
      add(operation.draft)
    }
  }
  const savedOwner = draftOwner(captured.saved)
  if (savedOwner) {
    hosts.add(savedOwner.executionHostId)
  }
  for (const { submission } of captured.submissions) {
    add(submission.draft)
  }
  if (captured.pending?.owner) {
    hosts.add(captured.pending.owner.executionHostId)
  }
  return hosts
}
