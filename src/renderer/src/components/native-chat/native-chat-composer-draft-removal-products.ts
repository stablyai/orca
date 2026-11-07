import { ephemeralDrafts, records, type DraftRecord } from './native-chat-composer-draft-memory'
import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import {
  nativeChatDraftValueKey,
  type NativeChatDraftRemovalScope
} from './native-chat-composer-draft-removal-capture'
import { savedNativeChatComposerDraftForm } from './native-chat-composer-draft-saved-value'
import { nativeChatComposerDraftJournalReplayKey } from './native-chat-composer-draft-journal'
import type { NativeChatDraftReturnEvent } from './native-chat-draft-return-products'

/** Evaluate the completed prefix across editors and their conversation before retiring any carrier. */
export function selectNativeChatDraftRemovalProducts(
  scopes: readonly NativeChatDraftRemovalScope[],
  events: readonly NativeChatDraftReturnEvent[],
  sources: ReadonlyMap<object, string>
) {
  const byScope = new Map(
    scopes
      .filter(({ scope, record, edit, destination }) => {
        const currentHost = records.get(scope)?.owner?.executionHostId
        return (
          (!currentHost ||
            !record?.owner?.executionHostId ||
            currentHost === record.owner.executionHostId) &&
          (!edit ||
            ((!ephemeralDrafts.has(scope) || ephemeralDrafts.get(scope) === edit) &&
              edit.returning?.destination === destination))
        )
      })
      .map((captured) => [captured.scope, captured])
  )
  const selected = new Map(
    scopes.map((captured) => [captured.scope, new Set([captured.record, undefined])])
  )
  const holders = new Map([...sources].filter(([, scope]) => byScope.has(scope)))
  const operations = new Map(
    scopes.map((captured) => [captured.scope, new Set(captured.operations)])
  )
  const addRecord = (captured: NativeChatDraftRemovalScope, value: DraftRecord | undefined) => {
    selected.get(captured.scope)!.add(value)
    if (value) {
      const saved = savedNativeChatComposerDraftForm(value)
      captured.expected.add(nativeChatDraftValueKey(saved))
      captured.loaded.add(nativeChatDraftValueKey(parseStoredNativeChatComposerDraft(saved)))
    }
  }
  const eligible = (scope: string, value: DraftRecord | undefined): boolean => {
    const captured = byScope.get(scope)
    if (!captured) {
      return false
    }
    if (selected.get(scope)?.has(value)) {
      return true
    }
    if (!value) {
      return false
    }
    const product = [...captured.attempts]
      .map((attempt) => attempt.installed.get(value))
      .find(Boolean)
    if (
      !product ||
      !(
        captured.expected.has(nativeChatDraftValueKey(product.input)) ||
        captured.loaded.has(
          nativeChatDraftValueKey(parseStoredNativeChatComposerDraft(product.input))
        )
      ) ||
      ![...product.journal].every((entry) => captured.journal.has(entry)) ||
      !product.appends.every((entry) => captured.operationSet.has(entry))
    ) {
      return false
    }
    addRecord(captured, value)
    if (product.write) {
      operations.get(scope)!.add(product.write)
    }
    return true
  }
  for (const event of events) {
    if ('permission' in event) {
      const from = byScope.get(event.from)
      if (
        from?.edit?.returning !== event.permission ||
        from.destination !== event.to ||
        !byScope.has(event.to) ||
        from.edit.returning.destination !== event.to
      ) {
        continue
      }
      for (const source of [...event.chips, ...event.pastes]) {
        if (holders.get(source) === event.from) {
          holders.set(source, event.to)
        }
      }
      continue
    }
    const captured = byScope.get(event.scope)
    if (
      !captured ||
      !event.sources.every(
        (source) =>
          sources.has(source) &&
          (holders.get(source) === event.scope ||
            (captured.destination === event.scope &&
              byScope.get(holders.get(source) ?? '')?.edit?.returning === source))
      )
    ) {
      continue
    }
    if (
      !eligible(event.scope, event.before) ||
      (event.sourceScope && !eligible(event.sourceScope, event.sourceRecord))
    ) {
      continue
    }
    addRecord(captured, event.after)
    for (const operation of event.operations) {
      captured.operationSet.add(operation)
      operations.get(event.scope)!.add(operation)
    }
    for (const entry of event.journal) {
      captured.derivedJournal.push(entry)
      captured.journal.add(nativeChatComposerDraftJournalReplayKey(entry))
    }
  }
  return {
    accepted: new Set(byScope.keys()),
    holders,
    operations,
    selected: new Map(
      scopes.map((captured) => [
        captured.scope,
        eligible(captured.scope, records.get(captured.scope))
      ])
    ),
    eligible
  }
}
