import { copySessionRecord } from './session-record-edit'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { SessionUnitIndex } from './session-unit-index'
import {
  sessionFieldIsPresent,
  isSessionMapField,
  type SessionMapField
} from './session-change-set'
import type { FieldTransition, SessionPresence } from './session-reader-types'
export class SessionReaderState {
  protected readonly transitions = new Map<keyof WorkspaceSessionState, FieldTransition>()

  protected readonly changed = new Map<SessionMapField, Set<string>>()

  protected readonly candidateIndex: SessionUnitIndex

  protected incoming?: { root: WorkspaceSessionState; revision: number }

  protected revision = 0

  protected cached?: { root: WorkspaceSessionState; revision: number }

  protected sealed = false

  protected mutate(): void {
    if (this.sealed) {
      throw new Error('Session preparation is sealed')
    }
    this.revision += 1
    this.cached = undefined
  }

  touchedFields(): readonly (keyof WorkspaceSessionState)[] {
    return [...this.transitions.keys()]
  }

  touches(field: keyof WorkspaceSessionState): boolean {
    return this.transitions.has(field)
  }

  replaces(field: keyof WorkspaceSessionState): boolean {
    return this.transitions.get(field)?.complete ?? false
  }

  changedKeys(field: SessionMapField): ReadonlySet<string> {
    return this.changed.get(field) ?? new Set()
  }

  protected shape(
    field: keyof WorkspaceSessionState,
    transition: FieldTransition
  ): SessionPresence<unknown> {
    if (!isSessionMapField(field)) {
      return transition.base
    }
    const intent = transition.intent!
    const present = sessionFieldIsPresent(
      field,
      intent.kind === 'unmentioned' && transition.entries?.size
        ? { kind: 'entries', present: transition.base.present }
        : intent,
      transition.count
    )
    if (!present) {
      return { present: false, value: undefined }
    }
    if (transition.count === 0 && transition.intent?.valueWhenEmpty === 'undefined') {
      return { present: true, value: undefined }
    }
    if (
      transition.count === 0 &&
      transition.base.present &&
      transition.base.value === undefined &&
      !transition.entries &&
      (transition.intent?.kind === 'replacement' || transition.intent?.kind === 'rollback')
    ) {
      return { present: true, value: undefined }
    }
    return { present: true, value: transition.base.value ?? {} }
  }

  protected resolve(field: keyof WorkspaceSessionState): SessionPresence<unknown> {
    const transition = this.transitions.get(field)
    if (!transition) {
      return Object.hasOwn(this.prior, field)
        ? { present: true, value: this.prior[field] }
        : { present: false, value: undefined }
    }
    if (transition.resolved) {
      return transition.resolved
    }
    const shape = this.shape(field, transition)
    if (!shape.present || shape.value === undefined || !transition.entries?.size) {
      return (transition.resolved = shape)
    }
    const set: Record<string, unknown> = {},
      remove: string[] = []
    for (const [key, entry] of transition.entries) {
      if (entry.present) {
        set[key] = entry.value
      } else {
        remove.push(key)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entry transitions exist only for a Record base.
    const base = transition.base.value as Readonly<Record<string, unknown>>
    return (transition.resolved = { present: true, value: copySessionRecord(base, set, remove) })
  }

  constructor(
    readonly prior: WorkspaceSessionState,
    readonly index: SessionUnitIndex
  ) {
    // Candidate contributions are separate from the published index until commit.
    this.candidateIndex = index.candidate()
  }

  protected transition(field: SessionMapField): FieldTransition {
    let transition = this.transitions.get(field)
    if (!transition) {
      const present = Object.hasOwn(this.prior, field)
      transition = {
        base: present
          ? { present, value: this.prior[field] }
          : { present: false, value: undefined },
        count: this.index.size(field),
        complete: false,
        intent: { kind: 'unmentioned', present }
      }
      this.transitions.set(field, transition)
    }
    return transition
  }
}
