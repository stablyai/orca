import type { StoreApi } from 'zustand'
import { describe, expect, it } from 'vitest'
import {
  editSessionSource,
  type SessionSourceEdit,
  type SessionSourceSet
} from './session-source-edits'
import { replaceSessionSourceFields } from './session-source-write-boundary'

type State = {
  editorDrafts: Record<string, string>
  openFiles: { id: string; worktreeId: string }[]
  activeTabId: string | null
  sortEpoch: number
}

// CI checks these call sites; rejected writes never execute in the runtime suite.
function sourceWriteContracts(
  set: SessionSourceSet<State>,
  state: State,
  raw: StoreApi<State>['setState']
) {
  const helper = () => ({ editorDrafts: { a: 'unreported' } })
  // @ts-expect-error keyed literals require the edit boundary.
  set({ editorDrafts: {} })
  // @ts-expect-error helper-return maps require the same boundary.
  set(helper())
  // @ts-expect-error conditional spreads cannot carry anonymous keyed replacements.
  set(() => ({ ...(state.sortEpoch ? helper() : {}) }))
  // @ts-expect-error source snapshots are values, never accepted writes.
  set(() => state)
  // @ts-expect-error spreading a snapshot does not authorize source fields.
  set(() => ({ ...state, editorDrafts: {} }))
  const finished = editSessionSource(state).set('editorDrafts', 'a', 'accepted').finish()
  // @ts-expect-error spreading an opaque result does not carry its accepted payload.
  set({ ...finished })
  // @ts-expect-error ordinary fields cannot turn a spread result into an accepted write.
  set({ ...finished, sortEpoch: 1 })
  // @ts-expect-error overwrites cannot borrow a finished edit's authority.
  set({ ...finished, editorDrafts: { b: 'unreported' } })
  // @ts-expect-error sequences require a collector or explicit ingress.
  set({ openFiles: [] })
  // @ts-expect-error narrowing the edit's state cannot authorize a hidden source field.
  editSessionSource({ sortEpoch: 0 }).finish({ editorDrafts: { a: 'unreported' } })
  // @ts-expect-error an empty state cannot manufacture an accepted source partial.
  editSessionSource({}).finish({ openFiles: [] })
  // @ts-expect-error a narrowed setter cannot be exposed as a broad Zustand setter.
  const broad: StoreApi<State>['setState'] = set
  // @ts-expect-error a broad setter cannot apply the opaque result contract.
  const narrowed: SessionSourceSet<State> = raw
  void broad
  void narrowed
  set({ sortEpoch: 1, activeTabId: null })
  set((current) => ({ sortEpoch: current.sortEpoch + 1 }))
  const narrow: SessionSourceEdit<Pick<State, 'editorDrafts'>> = editSessionSource(state)
  narrow.set('editorDrafts', 'a', 'accepted by a narrow helper')
  set(finished)
  set((current) => editSessionSource(current).set('editorDrafts', 'a', 'next').finish())
  // @ts-expect-error full ingress must name its authorized boundary.
  set(replaceSessionSourceFields({ editorDrafts: {} }))
  set(replaceSessionSourceFields({ editorDrafts: {} }, 'hydration'))
  set(replaceSessionSourceFields(state, 'hydration'), true)
  set(() => undefined)
}

describe('source setter compile contracts', () => {
  it('keeps the negative call sites available to CI without executing them', () => {
    expect(typeof sourceWriteContracts).toBe('function')
  })
})
