import type { WorkspaceSessionState } from './workspace-session-state-types'

import {
  SESSION_FIELD_POLICY,
  type SessionFieldPresenceIntent,
  isSessionMapField,
  type SessionMapField
} from './session-change-set'
import type {
  FieldTransition,
  SessionPresence,
  SessionEntry,
  SessionScalarField,
  SessionPolicyField
} from './session-reader-types'
import { SessionReaderState } from './session-reader-state'
export class SessionFieldReader extends SessionReaderState {
  unit<F extends SessionMapField>(
    field: F,
    key: string,
    phase: 'prior' | 'candidate' = 'candidate'
  ): SessionPresence<SessionEntry<F>> {
    const transition = phase === 'candidate' ? this.transitions.get(field) : undefined
    const entry = transition?.entries?.get(key)
    if (entry) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entries are admitted by the same typed map field.
      return entry as SessionPresence<SessionEntry<F>>
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: transitions for a map field hold that field's admitted entries.
    const map = (transition ? transition.base.value : this.prior[field]) as
      | Readonly<Record<string, SessionEntry<F>>>
      | undefined
    return map && Object.hasOwn(map, key)
      ? // SAFETY: this own property belongs to session map F.
        { present: true, value: map[key] }
      : { present: false, value: undefined }
  }

  field<F extends SessionScalarField>(
    field: F,
    phase: 'prior' | 'candidate' = 'candidate'
  ): SessionPresence<WorkspaceSessionState[F]> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution retains the field's admitted value type.
    return (
      phase === 'candidate'
        ? this.resolve(field)
        : Object.hasOwn(this.prior, field)
          ? { present: true, value: this.prior[field] }
          : { present: false, value: undefined }
    ) as SessionPresence<WorkspaceSessionState[F]>
  }

  policy<F extends SessionPolicyField>(
    field: F,
    phase: 'prior' | 'candidate' = 'candidate'
  ): WorkspaceSessionState[F] {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution retains the field's admitted value type.
    return (
      phase === 'prior' ? this.prior[field] : this.resolve(field).value
    ) as WorkspaceSessionState[F]
  }

  admitFields(requiredMaps = false): void {
    for (const field of Object.keys(SESSION_FIELD_POLICY)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the keys are the declared admission policy fields.
      const name = field as keyof typeof SESSION_FIELD_POLICY
      const policy = SESSION_FIELD_POLICY[name]
      const transition = this.transitions.get(name)
      const value = transition ? this.shape(name, transition).value : this.prior[name]
      if (value !== undefined) {
        continue
      }
      if (policy.undefined === 'prior' && this.prior[name] !== undefined) {
        this.replace(name, { present: true, value: this.prior[name] })
      } else if (requiredMaps && policy.undefined === 'empty') {
        this.replace(name, { present: true, value: {} })
      }
    }
  }

  entryCount(field: SessionMapField): number {
    return this.transitions.get(field)?.count ?? this.index.size(field)
  }

  reconcileField(field: SessionMapField, intent: SessionFieldPresenceIntent): void {
    this.mutate()
    const transition = this.transition(field)
    transition.intent = intent
    transition.resolved = undefined
  }

  write<F extends SessionMapField>(
    field: F,
    key: string,
    value: SessionPresence<SessionEntry<F>>
  ): void {
    const current = this.unit(field, key)
    if (current.present === value.present && current.value === value.value) {
      return
    }
    this.mutate()
    const transition = this.transition(field)
    if (value.present && transition.base.value === undefined) {
      transition.base = { present: true, value: {} }
      transition.intent = { kind: 'entries', present: true }
    }
    transition.entries ??= new Map()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this transition belongs to the admitted map field.
    const base = transition.base.value as Readonly<Record<string, unknown>> | null | undefined
    const basePresent = base != null && Object.hasOwn(base, key)
    if (basePresent === value.present && base?.[key] === value.value) {
      transition.entries.delete(key)
    } else {
      transition.entries.set(key, value)
    }
    transition.count += Number(value.present) - Number(current.present)
    transition.resolved = undefined
    const keys = this.changed.get(field) ?? new Set<string>()
    keys.add(key)
    this.changed.set(field, keys)
    this.candidateIndex.replace(field, key, value.value, value.present)
  }

  replace<F extends keyof WorkspaceSessionState>(
    field: F,
    value: SessionPresence<WorkspaceSessionState[F]>
  ): void {
    const priorTransition = this.transitions.get(field)
    const current = priorTransition
      ? this.shape(field, priorTransition)
      : Object.hasOwn(this.prior, field)
        ? { present: true, value: this.prior[field] }
        : { present: false, value: undefined }
    if (
      !priorTransition?.entries?.size &&
      current.present === value.present &&
      current.value === value.value
    ) {
      return
    }
    this.mutate()
    const transition: FieldTransition = { base: value, count: 0, complete: true }
    this.transitions.set(field, transition)
    if (isSessionMapField(field)) {
      transition.intent = {
        kind: 'replacement',
        present: value.present,
        explicitEmpty: value.present && value.value !== undefined
      }
      transition.count = Object.keys(value.value ?? {}).length
      const keys = new Set([...this.index.keys(field), ...(this.changed.get(field) ?? [])])
      for (const key of this.candidateIndex.keys(field)) {
        this.candidateIndex.replace(field, key, undefined, false)
      }
      for (const [key, entry] of Object.entries(value.value ?? {})) {
        keys.add(key)
        this.candidateIndex.replace(field, key, entry, true)
      }
      this.candidateIndex.orderField(field, Object.keys(value.value ?? {}))
      this.changed.set(field, keys)
    }
  }

  restoreField(field: keyof WorkspaceSessionState, present: boolean, value: unknown): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rollback receipts retain the typed field value captured by this reader.
    const restored = value as WorkspaceSessionState[typeof field]
    this.replace(
      field,
      present ? { present: true, value: restored } : { present: false, value: undefined }
    )
  }

  hasField(field: keyof WorkspaceSessionState): boolean {
    const transition = this.transitions.get(field)
    return transition ? this.shape(field, transition).present : Object.hasOwn(this.prior, field)
  }

  snapshot(): WorkspaceSessionState {
    if (this.cached?.revision === this.revision) {
      return this.cached.root
    }
    let root = this.prior
    if (this.transitions.size) {
      root = { ...this.prior }
      for (const field of this.transitions.keys()) {
        const value = this.resolve(field)
        if (value.present) {
          Object.assign(root, { [field]: value.value })
        } else {
          Reflect.deleteProperty(root, field)
        }
      }
    }
    const incoming = this.incoming
    if (
      incoming?.revision === this.revision &&
      [...this.transitions.keys()].every((field) => {
        const resolved = this.resolve(field)
        return (
          resolved.present === Object.hasOwn(incoming.root, field) &&
          resolved.value === incoming.root[field]
        )
      })
    ) {
      root = incoming.root
    }
    this.cached = { root, revision: this.revision }
    return root
  }
}
