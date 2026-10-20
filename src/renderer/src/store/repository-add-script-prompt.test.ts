import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryAddScriptPreview } from '../../../shared/repository-add-script-types'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('@/runtime/repository-add-script-execution', () => ({
  resolveRepositoryAddScriptPrompt: mocks.resolve
}))

import {
  createRepositoryAddScriptPromptStore,
  type RepositoryAddScriptPromptResolver
} from './repository-add-script-prompt'

let clock = 1_000

function advancePastGuard(): void {
  clock += 400
}

function preview(token: string): RepositoryAddScriptPreview {
  return {
    token,
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: `repo-${token}`,
    path: `/work/${token}`,
    target: { kind: 'native', cwd: `/work/${token}` },
    script: `echo ${token}`,
    scriptHash: `hash-${token}`
  }
}

function createStore(): {
  store: ReturnType<typeof createRepositoryAddScriptPromptStore>
  resolve: ReturnType<typeof vi.fn<RepositoryAddScriptPromptResolver>>
} {
  const resolve = vi.fn<RepositoryAddScriptPromptResolver>()
  return { store: createRepositoryAddScriptPromptStore(resolve), resolve }
}

function currentToken(
  store: ReturnType<typeof createRepositoryAddScriptPromptStore>
): string | null {
  return store.getState().current?.preview.token ?? null
}

beforeEach(() => {
  clock += 10_000
  mocks.resolve.mockReset()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.mocked(Date.now).mockRestore()
})

describe('repository add script prompt store', () => {
  it('shows the first offer and queues the second', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))

    expect(currentToken(store)).toBe('one')
    expect(resolve).not.toHaveBeenCalled()

    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(currentToken(store)).toBe('two')
    expect(resolve.mock.calls.map(([decision, offered]) => [decision, offered.token])).toEqual([
      ['run', 'one']
    ])
  })

  it('offers a repeated token only once while it is visible', () => {
    const { store } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('one'))

    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(currentToken(store)).toBeNull()
  })

  it('offers a repeated token only once while it waits in the queue', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))
    store.getState().offerRepositoryAddScript(preview('two'))

    store.getState().takeRepositoryAddScriptPrompt('run')
    advancePastGuard()
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(currentToken(store)).toBeNull()
  })

  it('lets the same token be offered again once it has left the queue', () => {
    const { store } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().takeRepositoryAddScriptPrompt('run')
    store.getState().offerRepositoryAddScript(preview('one'))

    expect(currentToken(store)).toBe('one')
  })

  // Why: a second click lands on the prompt that just appeared, and running that
  // repository's script is the consequence. The guard must hold both decisions.
  it('ignores an action that lands on the freshly revealed prompt', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))

    store.getState().takeRepositoryAddScriptPrompt('run')
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[1].token).toBe('one')
    expect(currentToken(store)).toBe('two')

    advancePastGuard()
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls[1]?.[1].token).toBe('two')
  })

  it('holds off a skip that lands on the freshly revealed prompt', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))

    store.getState().takeRepositoryAddScriptPrompt('skip')
    store.getState().takeRepositoryAddScriptPrompt('skip')

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[0]).toBe('skip')
    expect(currentToken(store)).toBe('two')
  })

  it('guards a prompt offered into the emptied slot', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().takeRepositoryAddScriptPrompt('run')

    // A registration can finish while the dialog closes and take the empty slot;
    // the second click of a double-click must not run that unseen prompt.
    store.getState().offerRepositoryAddScript(preview('two'))

    expect(store.getState().takeRepositoryAddScriptPrompt('run')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(currentToken(store)).toBe('two')

    advancePastGuard()
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls[1]?.[1].token).toBe('two')
  })

  it('releases the guard exactly when its window ends', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))
    store.getState().takeRepositoryAddScriptPrompt('run')

    // Why: pin the guard window itself; deriving it from the constant would follow any change.
    clock += 349
    expect(store.getState().takeRepositoryAddScriptPrompt('run')).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)

    clock += 1
    expect(store.getState().takeRepositoryAddScriptPrompt('run')?.preview.token).toBe('two')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('advances before the decision callback so a re-entrant read sees the next prompt', () => {
    const { store } = createStore()
    let seenDuringDecision: string | null = null

    store.getState().offerRepositoryAddScript(preview('one'), () => {
      seenDuringDecision = currentToken(store)
    })
    store.getState().offerRepositoryAddScript(preview('two'))

    const taken = store.getState().takeRepositoryAddScriptPrompt('run')

    expect(taken?.preview.token).toBe('one')
    expect(seenDuringDecision).toBe('two')
    expect(currentToken(store)).toBe('two')
  })

  it('passes each decision with the entry it belongs to', () => {
    const { store, resolve } = createStore()

    store.getState().offerRepositoryAddScript(preview('one'))
    store.getState().offerRepositoryAddScript(preview('two'))

    store.getState().takeRepositoryAddScriptPrompt('skip')
    advancePastGuard()
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(resolve.mock.calls.map(([decision, offered]) => [decision, offered.token])).toEqual([
      ['skip', 'one'],
      ['run', 'two']
    ])
  })

  it('hands a decision to the real executor when an offer names no resolver', () => {
    const store = createRepositoryAddScriptPromptStore()
    const offered = preview('one')

    store.getState().offerRepositoryAddScript(offered)
    store.getState().takeRepositoryAddScriptPrompt('run')

    expect(mocks.resolve).toHaveBeenCalledWith(offered, 'run')
  })

  it('is inert when nothing is on screen', () => {
    const { store, resolve } = createStore()

    expect(store.getState().takeRepositoryAddScriptPrompt('run')).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })
})
