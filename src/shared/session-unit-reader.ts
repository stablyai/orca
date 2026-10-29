export { type SessionUnitSelection, selectSessionUnits } from './session-unit-selection'

import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from './workspace-session-host-field-ownership'
import { getRepoIdFromWorktreeId } from './worktree/id'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type {
  SessionUnitIndex,
  SessionUnitAddress,
  SessionReferenceKind
} from './session-unit-index'
import {
  isSessionMapField,
  type SessionAdmissionKind,
  type SessionUnitChange,
  type SessionMapField
} from './session-change-set'
import {
  type SessionUnitView,
  type SessionEntry,
  type PreparedSession,
  isSessionUnitView
} from './session-reader-types'
export type {
  SessionUnitView,
  SessionPresence,
  SessionEntry,
  SessionScalarField,
  SessionPolicyField,
  PreparedSession
} from './session-reader-types'
import { SessionReaderQueries } from './session-reader-queries'
import {
  resolveSessionUnits,
  type SessionUnitSelection,
  type SessionOperationRoot
} from './session-unit-selection'
export { isSessionUnitView } from './session-reader-types'

export class SessionUnitReader extends SessionReaderQueries {
  static between(
    prior: WorkspaceSessionState,
    candidate: WorkspaceSessionState,
    index: SessionUnitIndex
  ): SessionUnitReader {
    const reader = new SessionUnitReader(prior, index)
    for (const field of new Set([...Object.keys(prior), ...Object.keys(candidate)])) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both enumerated roots are session DTOs.
      const key = field as keyof WorkspaceSessionState
      if (
        prior[key] === candidate[key] &&
        Object.hasOwn(prior, key) === Object.hasOwn(candidate, key)
      ) {
        continue
      }
      reader.replace(
        key,
        Object.hasOwn(candidate, key)
          ? { present: true, value: candidate[key] }
          : { present: false, value: undefined }
      )
    }
    reader.incoming = { root: candidate, revision: reader.revision }
    return reader
  }

  view(phase: 'prior' | 'candidate'): SessionUnitView {
    if (phase === 'candidate') {
      return this
    }
    return {
      index: this.index,
      unit: (field, key) => this.unit(field, key, 'prior'),
      field: (field) => this.field(field, 'prior'),
      hasField: (field) => Object.hasOwn(this.prior, field),
      map: (field, keys) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every selected entry comes from this same typed map in the captured root.
        return Object.fromEntries(
          this.index
            .ordered(field, keys)
            .filter((key) => Object.hasOwn(this.prior[field] ?? {}, key))
            .map((key) => [key, this.prior[field]?.[key]])
        ) as NonNullable<WorkspaceSessionState[typeof field]>
      },
      references: (kind, id) => this.references(kind, id, 'prior')
    }
  }

  private dependencyCache?: { revision: number; full: boolean; units: SessionUnitSelection }
  private ownerSelectionRevision = -1
  private ownerSelections = new WeakMap<SessionUnitSelection, ReadonlySet<string>>()
  private readonly dependencySeeds = new Map<SessionMapField, Set<string>>()
  private readonly operationRoots = new Map<SessionReferenceKind, Set<string>>()
  private impactRevision = -1
  private readonly impacts = new Map<SessionMapField, Map<string, boolean>>()

  unitChanged(field: SessionMapField, key: string): boolean {
    if (this.impactRevision !== this.revision) {
      this.impacts.clear()
      this.impactRevision = this.revision
    }
    const fieldImpacts = this.impacts.get(field) ?? new Map<string, boolean>()
    const cached = fieldImpacts.get(key)
    if (cached !== undefined) {
      return cached
    }
    const prior = this.unit(field, key, 'prior'),
      candidate = this.unit(field, key)
    const changed = prior.present !== candidate.present || prior.value !== candidate.value
    fieldImpacts.set(key, changed)
    this.impacts.set(field, fieldImpacts)
    return changed
  }

  private typedRoots(): SessionOperationRoot[] {
    return [...this.operationRoots].flatMap(([kind, ids]) => [...ids].map((id) => ({ kind, id })))
  }

  selection(extra: readonly SessionUnitAddress[] = [], full = false): SessionUnitSelection {
    for (const { field, key } of extra) {
      const keys = this.dependencySeeds.get(field) ?? new Set<string>()
      if (!keys.has(key)) {
        this.mutate()
        keys.add(key)
        this.dependencySeeds.set(field, keys)
        this.dependencyCache = undefined
      }
    }
    if (this.dependencyCache?.revision === this.revision && this.dependencyCache.full === full) {
      return this.dependencyCache.units
    }
    const seeds = [...this.dependencySeeds].flatMap(([field, keys]) =>
      [...keys].map((key) => ({ field, key }))
    )
    const units = resolveSessionUnits(this, seeds, full, true, this.typedRoots())
    this.dependencyCache = { revision: this.revision, full, units }
    return units
  }

  selectReferences(
    identities: readonly { kind: SessionReferenceKind; id: string }[],
    full = false
  ): SessionUnitSelection {
    for (const { kind, id } of identities) {
      const ids = this.operationRoots.get(kind) ?? new Set<string>()
      if (!ids.has(id)) {
        this.mutate()
        ids.add(id)
        this.operationRoots.set(kind, ids)
      }
    }
    return this.selection([], full)
  }

  affectedOwners(selection = this.selection()): ReadonlySet<string> {
    if (this.ownerSelectionRevision !== this.revision) {
      this.ownerSelections = new WeakMap()
      this.ownerSelectionRevision = this.revision
    }
    const cached = this.ownerSelections.get(selection)
    if (cached) {
      return cached
    }
    const owners = new Set<string>()
    for (const [field, keys] of selection) {
      for (const key of keys) {
        if (WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'worktreeKeyed') {
          owners.add(key)
        }
        for (const owner of this.dependencyIds(field, key, 'owner')) {
          owners.add(owner)
        }
      }
    }
    this.ownerSelections.set(selection, owners)
    return owners
  }

  prepare(options: {
    kind: SessionAdmissionKind
    fullReplacement?: boolean
    partitionDeleted?: boolean
    relatedViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
    effects?: readonly (() => void)[]
  }): PreparedSession {
    const root = this.snapshot()
    const units: SessionUnitChange[] = []
    const orders = new Map<SessionMapField, readonly string[]>()
    for (const [field, transition] of this.transitions) {
      if (isSessionMapField(field)) {
        for (const key of this.changedKeys(field)) {
          const before = this.unit(field, key, 'prior'),
            after = this.unit(field, key)
          if (this.unitChanged(field, key)) {
            units.push({
              field,
              key,
              prior: before.value,
              next: after.value,
              priorPresent: before.present,
              nextPresent: after.present
            })
          }
        }
        if (transition.complete) {
          const priorKeys = [...this.index.keys(field)],
            nextKeys = this.keys(field)
          if (
            priorKeys.length !== nextKeys.length ||
            priorKeys.some((key, position) => key !== nextKeys[position])
          ) {
            orders.set(field, nextKeys)
          }
        }
        if (
          Object.hasOwn(this.prior, field) === Object.hasOwn(root, field) &&
          (this.prior[field] === undefined) === (root[field] === undefined) &&
          !orders.has(field)
        ) {
          continue
        }
      } else if (
        this.prior[field] === root[field] &&
        Object.hasOwn(this.prior, field) === Object.hasOwn(root, field)
      ) {
        continue
      }
      units.push({
        field,
        key: null,
        prior: this.prior[field],
        next: root[field],
        priorPresent: Object.hasOwn(this.prior, field),
        nextPresent: Object.hasOwn(root, field)
      })
    }
    const dependencyUnits = resolveSessionUnits(
      this,
      [
        ...units.flatMap((unit) =>
          unit.key === null ? [] : [{ field: unit.field, key: unit.key }]
        ),
        ...[...this.dependencySeeds].flatMap(([field, keys]) =>
          [...keys].map((key) => ({ field, key }))
        )
      ],
      false,
      false,
      this.typedRoots()
    )
    this.dependencyCache = { revision: this.revision, full: false, units: dependencyUnits }
    const affected = {
      units: dependencyUnits,
      owners: this.affectedOwners(dependencyUnits),
      tabs: new Set<string>(),
      panes: new Set<string>(),
      files: new Set<string>(),
      pages: new Set<string>(),
      repos: new Set<string>()
    }
    for (const unit of units) {
      if (unit.key === null) {
        continue
      }
      for (const [kind, target] of [
        ['tab', affected.tabs],
        ['pane', affected.panes],
        ['file', affected.files],
        ['page', affected.pages],
        ['repo', affected.repos]
      ] as const) {
        for (const id of this.ids(unit.field, unit.key, kind)) {
          target.add(id)
        }
      }
    }
    for (const owner of affected.owners) {
      affected.repos.add(getRepoIdFromWorktreeId(owner))
    }
    this.sealed = true
    return {
      prior: this.prior,
      root,
      ...options,
      fullReplacement: options.fullReplacement ?? false,
      partitionDeleted: options.partitionDeleted ?? false,
      units,
      affected,
      orders,
      effects: options.effects ?? []
    }
  }
}

export function readSessionUnit<F extends SessionMapField>(
  source: WorkspaceSessionState | SessionUnitView,
  field: F,
  key: string
): SessionEntry<F> | undefined {
  if (isSessionUnitView(source)) {
    return source.unit(field, key).value
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected map F and its string key retain the same entry type.
  return source[field]?.[key] as SessionEntry<F> | undefined
}
