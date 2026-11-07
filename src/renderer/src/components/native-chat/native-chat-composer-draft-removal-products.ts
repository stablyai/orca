import type { NativeChatDraftReturnSource } from './native-chat-draft-return-products'
import { ephemeralDrafts, records, type DraftRecord } from './native-chat-composer-draft-memory'
import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import {
  nativeChatDraftValueKey,
  type NativeChatDraftRemovalScope
} from './native-chat-composer-draft-removal-capture'
import { savedNativeChatComposerDraftForm } from './native-chat-composer-draft-saved-value'
import { nativeChatComposerDraftJournalReplayKey } from './native-chat-composer-draft-journal'
import type { NativeChatDraftReturnEvent } from './native-chat-draft-return-products'
import { nativeChatDraftRemovalDependencies } from './native-chat-draft-removal-dependencies'

/** Evaluate the completed prefix across editors and their conversation before retiring any carrier. */
export function selectNativeChatDraftRemovalProducts(
  scopes: readonly NativeChatDraftRemovalScope[],
  events: readonly NativeChatDraftReturnEvent[],
  sources: ReadonlyMap<NativeChatDraftReturnSource, string>
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
  const dependencies = nativeChatDraftRemovalDependencies()
  const never = dependencies.fact()
  const valueKeys = new Map<unknown, string>()
  const parsedKeys = new Map<unknown, string | undefined>()
  const key = (value: unknown) => {
    if (!valueKeys.has(value)) {
      valueKeys.set(value, nativeChatDraftValueKey(value))
    }
    return valueKeys.get(value)!
  }
  const parsedKey = (value: unknown) => {
    if (!parsedKeys.has(value)) {
      const parsed = parseStoredNativeChatComposerDraft(value)
      parsedKeys.set(value, parsed ? key(parsed) : undefined)
    }
    return parsedKeys.get(value)
  }
  const rows = new Map(
    [...byScope].map(([scope, captured]) => [
      scope,
      {
        captured,
        raw: dependencies.index(captured.expected),
        loaded: dependencies.index(captured.loaded),
        journal: dependencies.index(captured.journal),
        tokens: dependencies.index(captured.operationSet),
        records: dependencies.index(new Set([captured.record, undefined])),
        checked: new Set<DraftRecord>(),
        normalized: new Set([captured.record, undefined]),
        operations: new Set<NativeChatDraftRemovalScope['operations'][number]>()
      }
    ])
  )
  for (const row of rows.values()) {
    const byOutput = new Map<string, typeof row.captured.predecessors>()
    for (const pair of row.captured.predecessors) {
      const held = byOutput.get(pair.output) ?? []
      held.push(pair)
      byOutput.set(pair.output, held)
    }
    const pending = [...row.captured.censusRoots]
    const visited = new Set(pending)
    for (let at = 0; at < pending.length; at += 1) {
      for (const pair of byOutput.get(pending[at]) ?? []) {
        if (pair.loaded) {
          row.loaded.add(pair.loaded)
        }
        if (!visited.has(pair.input)) {
          visited.add(pair.input)
          pending.push(pair.input)
        }
      }
    }
  }
  const holders = new Map([...sources].filter(([, scope]) => byScope.has(scope)))
  const addValue = (scope: string, value: unknown) => {
    const row = rows.get(scope)!
    row.raw.add(key(value))
    const parsed = parsedKey(value)
    if (parsed) {
      row.loaded.add(parsed)
    }
  }
  const selectOperation = (
    scope: string,
    operation: NativeChatDraftRemovalScope['operations'][number]
  ) => {
    const row = rows.get(scope)!
    if (row.operations.has(operation)) {
      return
    }
    row.operations.add(operation)
    row.tokens.add(operation)
    if ('draft' in operation) {
      addValue(scope, operation.draft)
    } else if (operation.applied) {
      const { input, output } = operation.applied
      dependencies.all([row.raw.get(key(input))], () => addValue(scope, output))
    }
  }
  const addRecord = (scope: string, value: DraftRecord | undefined) => {
    const row = rows.get(scope)!
    if (!row.normalized.has(value)) {
      row.normalized.add(value)
      if (value) {
        addValue(scope, savedNativeChatComposerDraftForm(value))
      }
    }
    row.records.add(value)
  }
  const eligible = (scope: string, value: DraftRecord | undefined) => {
    const row = rows.get(scope)
    if (!row) {
      return never
    }
    const result = row.records.get(value)
    if (result.ready || !value || row.checked.has(value)) {
      return result
    }
    row.checked.add(value)
    const product = [...row.captured.attempts]
      .map((attempt) => attempt.installed.get(value))
      .find(Boolean)
    if (product) {
      const parsed = parsedKey(product.input)
      dependencies.all(
        [
          dependencies.any([
            row.raw.get(key(product.input)),
            parsed ? row.loaded.get(parsed) : never
          ]),
          ...[...product.journal].map((entry) => row.journal.get(entry)),
          ...product.appends.map((operation) => row.tokens.get(operation))
        ],
        () => {
          addRecord(scope, value)
          if (product.write) {
            selectOperation(scope, product.write)
          }
        }
      )
    }
    return result
  }
  for (const [scope, row] of rows) {
    for (const operation of row.captured.operations) {
      selectOperation(scope, operation)
    }
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
    dependencies.all(
      [
        eligible(event.scope, event.before),
        ...(event.sourceScope ? [eligible(event.sourceScope, event.sourceRecord)] : [])
      ],
      () => {
        addRecord(event.scope, event.after)
        for (const operation of event.operations) {
          selectOperation(event.scope, operation)
        }
        for (const entry of event.journal) {
          captured.derivedJournal.push(entry)
          rows.get(event.scope)!.journal.add(nativeChatComposerDraftJournalReplayKey(entry))
        }
      }
    )
  }
  const current = new Map(scopes.map(({ scope }) => [scope, records.get(scope)]))
  const decisions = new Map([...current].map(([scope, value]) => [scope, eligible(scope, value)]))
  dependencies.drain()
  return {
    accepted: new Set(byScope.keys()),
    holders,
    operations: new Map([...rows].map(([scope, row]) => [scope, row.operations])),
    current,
    selected: new Map([...decisions].map(([scope, decision]) => [scope, decision.ready]))
  }
}
