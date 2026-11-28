import v8 from 'node:v8'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { atom, captureAtomValues, read, resetAtoms, set } from './declarative-atoms'

type BunRuntime = { gc: (sync?: boolean) => void }

function isBunRuntime(value: unknown): value is BunRuntime {
  return (
    typeof value === 'object' && value !== null && 'gc' in value && typeof value.gc === 'function'
  )
}

function forceGarbageCollection(): () => void {
  const scope: Record<string, unknown> = globalThis
  if (isBunRuntime(scope.Bun)) {
    const bun = scope.Bun
    return () => {
      bun.gc(true)
    }
  }
  v8.setFlagsFromString('--expose_gc')
  const gc: unknown = vm.runInNewContext('gc')
  if (typeof gc !== 'function') {
    throw new Error('Failed to expose gc()')
  }
  return () => {
    gc()
  }
}

async function collectGarbage(gc: () => void, refs: WeakRef<object>[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (refs.every((ref) => ref.deref() === undefined)) {
      return
    }
  }
}

function createAndDiscardAnonymousAtoms(count: number): WeakRef<object>[] {
  const refs: WeakRef<object>[] = []
  for (let index = 0; index < count; index++) {
    const initial = { id: index, payload: new Uint8Array(256) }
    const updated = { id: index, payload: new Uint8Array(256) }
    const transient = atom(initial)
    set(transient, updated)
    refs.push(new WeakRef(transient), new WeakRef(initial), new WeakRef(updated))
  }
  return refs
}

describe('declarative-atoms lifetime ownership', () => {
  it('releases discarded anonymous atoms and payloads while preserving reset and snapshot semantics for live atoms', async () => {
    const gc = forceGarbageCollection()
    const liveAnonymous = atom('initial')
    const liveKeyed = atom('sta-13323-live-keyed', 1)

    set(liveAnonymous, 'changed')
    set(liveKeyed, 2)

    const discardedRefs = createAndDiscardAnonymousAtoms(200)

    resetAtoms()
    expect(read(liveAnonymous)).toBe('initial')
    expect(read(liveKeyed)).toBe(1)

    await collectGarbage(gc, discardedRefs)
    const retainedCount = discardedRefs.filter((ref) => ref.deref() !== undefined).length
    // Allow a small margin for conservative stack scanning; without the fix all 600 refs stay live.
    expect(retainedCount).toBeLessThan(10)

    set(liveAnonymous, 'snapshotted')
    const restore = captureAtomValues()
    set(liveAnonymous, 'after-snapshot')
    restore()
    expect(read(liveAnonymous)).toBe('snapshotted')
  })
})
