import { type SessionEntry, SessionUnitReader } from './session-unit-reader'
import { describe, expect, it } from 'vitest'
import { observeSessionRecordCopies } from './session-record-edit'
import { getDefaultWorkspaceSession } from './constants'
import { SESSION_MAP_FIELDS } from './session-change-set'
import { SessionUnitIndex } from './session-unit-index'

import { patchSessionUnits } from './workspace-layout/workspace-layout-record-patch'
import type { WorkspaceSessionState } from './workspace-session-state-types'

function root(field: string, shape: 'absent' | 'undefined' | 'empty' | 'populated') {
  const value = getDefaultWorkspaceSession()
  Reflect.deleteProperty(value, field)
  if (shape !== 'absent') {
    Object.assign(value, {
      [field]:
        shape === 'undefined'
          ? undefined
          : shape === 'empty'
            ? {}
            : { selected: field === 'tabsByWorktree' ? [] : 'value' }
    })
  }
  return value
}

function freeze(value: WorkspaceSessionState): WorkspaceSessionState {
  for (const map of Object.values(value)) {
    if (map && typeof map === 'object') {
      Object.freeze(map)
    }
  }
  return Object.freeze(value)
}

const shapes = ['absent', 'undefined', 'empty', 'populated'] as const

class CoalescingReader extends SessionUnitReader {
  checkRetainedEntries(): void {
    for (const transition of this.transitions.values()) {
      for (const [key, entry] of transition.entries ?? []) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retained entry transitions belong to map fields.
        const base = transition.base.value as Readonly<Record<string, unknown>> | undefined
        expect(
          Object.hasOwn(base ?? {}, key) === entry.present && base?.[key] === entry.value
        ).toBe(false)
      }
    }
  }
}

it('coalesces base-relative entries against native operations without discarded admission spreads', () => {
  for (const field of SESSION_MAP_FIELDS) {
    const prior = freeze(root(field, 'populated'))
    const reader = new CoalescingReader(prior, new SessionUnitIndex(prior))
    const base = prior[field]?.selected
    let model = { ...prior }
    for (const value of [undefined, base, 'changed', base]) {
      const next = { ...model[field] }
      if (value === undefined) {
        Reflect.deleteProperty(next, 'selected')
      } else {
        Object.assign(next, { selected: value })
      }
      model = { ...model, [field]: next }
      reader.write(
        field,
        'selected',
        value === undefined
          ? { present: false, value: undefined }
          : // SAFETY: the policy matrix uses opaque entries of the same domain as root().
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy matrix uses opaque entries of the same domain as root().
            { present: true, value: value as SessionEntry<typeof field> }
      )
      reader.checkRetainedEntries()
    }
    let copies = 0
    const stop = observeSessionRecordCopies(() => copies++)
    try {
      reader.admitFields()
      expect(copies).toBe(0)
      expect(reader.snapshot()).toStrictEqual(model)
      expect(reader.snapshot()[field]).toBe(prior[field])
      expect(copies).toBe(0)
    } finally {
      stop()
    }
  }
})

describe('scope-aware map field presence', () => {
  for (const field of SESSION_MAP_FIELDS) {
    it(`${field}: complete, selected and unmentioned input preserve their distinct domains`, () => {
      for (const shape of shapes) {
        const prior = freeze(root(field, shape))
        const original = structuredClone(prior)
        const index = new SessionUnitIndex(prior)
        // Unmentioned patch input retains own-undefined and absent shapes exactly.
        const untouched = new SessionUnitReader(prior, index)
        expect(untouched.snapshot()).toBe(prior)
        expect(untouched.hasField(field)).toBe(Object.hasOwn(prior, field))
        for (const kind of ['complete', 'selected'] as const) {
          for (const output of ['absent', 'empty'] as const) {
            const after = root(field, output)
            const reader = new SessionUnitReader(prior, index)
            patchSessionUnits(
              reader,
              prior,
              after,
              kind === 'complete'
                ? { kind }
                : { kind, fields: new Map([[field, new Set(['selected'])]]) }
            )
            const next = reader.snapshot()
            const required = field === 'tabsByWorktree' || field === 'terminalLayoutsByTabId'
            // An unchanged serializer field is unmentioned; otherwise output intent governs emptiness.
            const changed = shape === 'populated' || (shape === 'empty') !== (output === 'empty')
            const present = changed ? required || output === 'empty' : Object.hasOwn(prior, field)
            expect(Object.hasOwn(next, field), `${shape}/${kind}/${output}`).toBe(present)
            expect(reader.hasField(field)).toBe(present)
            expect(reader.entryCount(field)).toBe(new SessionUnitIndex(next).size(field))
          }
        }
        expect(prior).toStrictEqual(original)
      }
    })
  }

  it('selected omission keeps orphan own-undefined entries without enumerating unrelated content', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: {
        selected: 'value',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this legacy ingress case intentionally includes an invalid own-undefined entry.
        orphan: undefined as never
      }
    })
    const index = new SessionUnitIndex(prior)
    expect(index.size('terminalPtyIncarnationsByPaneKey')).toBe(2)
    const reader = new SessionUnitReader(prior, index)
    reader.write('terminalPtyIncarnationsByPaneKey', 'selected', {
      present: false,
      value: undefined
    })
    reader.reconcileField('terminalPtyIncarnationsByPaneKey', { kind: 'output', present: false })
    expect(reader.entryCount('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(reader.hasField('terminalPtyIncarnationsByPaneKey')).toBe(true)
    expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toStrictEqual({ orphan: undefined })
  })

  it('orders a newly inserted integer key like a full materialized Record', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { '2': [], other: [] }
    })
    const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
    reader.write('tabsByWorktree', '1', { present: true, value: [] })
    const fullKeys = Object.keys(reader.snapshot().tabsByWorktree)
    expect(fullKeys).toEqual(['1', '2', 'other'])
    expect(reader.keys('tabsByWorktree')).toEqual(fullKeys)
    expect(reader.ordered('tabsByWorktree', ['other', '1', '2'])).toEqual(fullKeys)
  })

  it('clear then add uses the replacement domain and rollback restores exact presence', () => {
    for (const shape of shapes) {
      const prior = freeze(root('terminalPtyIncarnationsByPaneKey', shape))
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: {} })
      reader.write('terminalPtyIncarnationsByPaneKey', 'new:leaf', { present: true, value: 'new' })
      expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toEqual({ 'new:leaf': 'new' })
      const next = reader.snapshot()
      const rollback = new SessionUnitReader(next, new SessionUnitIndex(next))
      rollback.replace(
        'terminalPtyIncarnationsByPaneKey',
        Object.hasOwn(prior, 'terminalPtyIncarnationsByPaneKey')
          ? { present: true, value: prior.terminalPtyIncarnationsByPaneKey }
          : { present: false, value: undefined }
      )
      rollback.reconcileField('terminalPtyIncarnationsByPaneKey', {
        kind: 'rollback',
        present: Object.hasOwn(prior, 'terminalPtyIncarnationsByPaneKey')
      })
      expect(rollback.snapshot()).toStrictEqual(prior)
    }
  })
})

describe('complete own-undefined replacement followed by keyed output', () => {
  it('publishes a subsequent incarnation entry through the same presence result as the reader', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: { 'prior:leaf': 'old' }
    })
    const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
    reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: undefined })
    reader.write('terminalPtyIncarnationsByPaneKey', 'next:leaf', { present: true, value: 'fresh' })
    expect(reader.hasField('terminalPtyIncarnationsByPaneKey')).toBe(true)
    expect(reader.entryCount('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(reader.unit('terminalPtyIncarnationsByPaneKey', 'next:leaf').value).toBe('fresh')
    const installed = reader.snapshot()
    expect(installed.terminalPtyIncarnationsByPaneKey).toStrictEqual({ 'next:leaf': 'fresh' })
    expect(new SessionUnitIndex(installed).size('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(prior.terminalPtyIncarnationsByPaneKey).toStrictEqual({ 'prior:leaf': 'old' })
  })
})

describe('resolved field transitions against independent native values', () => {
  for (const field of SESSION_MAP_FIELDS) {
    it(`${field}: replacement, promotion, selected edits and retained snapshots agree`, () => {
      for (const shape of shapes) {
        const prior = freeze(root(field, shape))
        const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
        let model = { ...prior }
        const retained: { root: WorkspaceSessionState; saved: WorkspaceSessionState }[] = []
        const compare = () => {
          const snapshot = reader.snapshot()
          expect(snapshot).toStrictEqual(model)
          expect(reader.snapshot()).toBe(snapshot)
          expect(reader.hasField(field)).toBe(Object.hasOwn(model, field))
          expect(reader.keys(field)).toEqual(Object.keys(model[field] ?? {}))
          expect(reader.entryCount(field)).toBe(Object.keys(model[field] ?? {}).length)
          for (const key of ['selected', '1', '2', 'next', 'ownUndefined']) {
            expect(reader.unit(field, key).present).toBe(Object.hasOwn(model[field] ?? {}, key))
            expect(reader.unit(field, key).value).toBe(model[field]?.[key])
          }
          retained.push({ root: snapshot, saved: structuredClone(snapshot) })
          freeze(snapshot)
          for (const old of retained) {
            expect(old.root).toStrictEqual(old.saved)
          }
        }
        compare()
        // A complete own-undefined replacement followed by a set starts a new empty domain.
        reader.replace(field, { present: true, value: undefined })
        model = { ...model, [field]: undefined }
        compare()
        const value = field === 'tabsByWorktree' ? [] : 'fresh'
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generic policy matrix uses opaque entries; index parsing accepts unknown shapes.
        const entry = value as SessionEntry<typeof field>
        reader.write(field, 'next', { present: true, value: entry })
        model = { ...model, [field]: { next: value } }
        compare()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matrix intentionally exercises an invalid own-undefined entry from legacy ingress.
        reader.write(field, 'ownUndefined', { present: true, value: undefined as never })
        model = { ...model, [field]: { ...model[field], ownUndefined: undefined } }
        compare()
        reader.write(field, 'next', { present: false, value: undefined })
        const next = { ...model[field] }
        Reflect.deleteProperty(next, 'next')
        model = { ...model, [field]: next }
        compare()
        reader.write(field, 'ownUndefined', { present: false, value: undefined })
        model = { ...model, [field]: {} }
        if (
          [
            'sleepingAgentSessionsByPaneKey',
            'terminalPtyIncarnationsByPaneKey',
            'closedTerminalTabTombstonesByTabId'
          ].includes(field)
        ) {
          Reflect.deleteProperty(model, field)
        }
        compare()
        reader.replace(field, { present: false, value: undefined })
        model = { ...model }
        if (field === 'tabsByWorktree' || field === 'terminalLayoutsByTabId') {
          Object.assign(model, { [field]: {} })
        } else {
          Reflect.deleteProperty(model, field)
        }
        compare()
        // An explicit empty whole-field result survives even when selected emptiness retires a field.
        reader.replace(field, { present: true, value: {} })
        model = { ...model, [field]: {} }
        compare()
        // Whole replacements, including delete/reinsert, follow native integer and string order.
        const ordered = { '2': value, selected: value, '1': value }
        // SAFETY: the matrix supplies the same opaque entry type used above.
        reader.replace(field, {
          present: true,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the matrix supplies the same opaque entry type used above.
          value: ordered as NonNullable<WorkspaceSessionState[typeof field]>
        })
        model = { ...model, [field]: ordered }
        compare()
        const reordered = { ...ordered }
        Reflect.deleteProperty(reordered, 'selected')
        reordered.selected = value
        // SAFETY: native replacement keeps the matrix's opaque entry type.
        reader.replace(field, {
          present: true,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native replacement keeps the matrix's opaque entry type.
          value: reordered as NonNullable<WorkspaceSessionState[typeof field]>
        })
        model = { ...model, [field]: reordered }
        compare()
        const prepared = reader.prepare({ kind: 'authoritative' })
        expect(prepared.root).toBe(reader.snapshot())
        expect(prepared.root).toStrictEqual(model)
        expect(() => reader.write(field, 'new', { present: true, value: entry })).toThrow('sealed')
        expect(prior).toStrictEqual(retained[0].saved)
      }
    })
  }
})

it('prepares a complete native-order replacement without enumerating the prior Record', () => {
  let enumerations = 0
  const records = {
    a: { closedAt: 1, worktreeId: 'repo::/a' },
    b: { closedAt: 2, worktreeId: 'repo::/b' }
  }
  const prior = freeze({
    ...getDefaultWorkspaceSession(),
    closedTerminalTabTombstonesByTabId: new Proxy(records, {
      ownKeys(value) {
        enumerations++
        return Reflect.ownKeys(value)
      }
    })
  })
  const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
  const replacement = { b: records.b, a: records.a }
  reader.replace('closedTerminalTabTombstonesByTabId', { present: true, value: replacement })
  enumerations = 0
  const prepared = reader.prepare({ kind: 'authoritative' })
  expect(enumerations).toBe(0)
  expect(prepared.orders.get('closedTerminalTabTombstonesByTabId')).toEqual(
    Object.keys(replacement)
  )
  expect(prepared.units).toContainEqual(
    expect.objectContaining({
      field: 'closedTerminalTabTombstonesByTabId',
      key: null,
      nextPresent: true
    })
  )
  expect(Object.keys(prepared.root.closedTerminalTabTombstonesByTabId!)).toEqual(['b', 'a'])
  expect(Object.keys(records)).toEqual(['a', 'b'])
})
