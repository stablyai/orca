// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory } from '../../../shared/skill-freshness'
import {
  _skillFreshnessCacheForTests,
  type SkillFreshnessState,
  useSkillFreshness
} from './useSkillFreshness'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function inventory(scannedAt: number, eligibleUpdateNames: string[] = []): SkillFreshnessInventory {
  return { schemaVersion: 1, installations: [], eligibleUpdateNames, scannedAt }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let state: SkillFreshnessState | null = null
const states = new Map<string, SkillFreshnessState>()

function Probe({ id = 'default' }: { id?: string }): null {
  state = useSkillFreshness()
  states.set(id, state)
  return null
}

describe('useSkillFreshness', () => {
  beforeEach(() => {
    _skillFreshnessCacheForTests.reset()
    state = null
    states.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('runs a follow-up scan when invalidated during an in-flight request', async () => {
    const first = deferred<SkillFreshnessInventory>()
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () => root?.render(<Probe />))
    expect(freshnessInventory).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => first.resolve(inventory(1)))
    expect(freshnessInventory).toHaveBeenCalledTimes(2)

    await act(async () => second.resolve(inventory(2)))
    expect(state?.inventory?.scannedAt).toBe(2)
  })

  it('skips focus rescans inside the cooldown but honors install-change events', async () => {
    const first = deferred<SkillFreshnessInventory>()
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () => root?.render(<Probe />))
    await act(async () => first.resolve(inventory(1)))
    expect(freshnessInventory).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(freshnessInventory).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    await act(async () => second.resolve(inventory(2)))
    expect(freshnessInventory).toHaveBeenCalledTimes(2)
    expect(state?.inventory?.scannedAt).toBe(2)
  })

  it('retracts stale update authority during the cooldown and runs one trailing focus scan', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockResolvedValueOnce(inventory(1, ['orca-cli']))
      .mockReturnValueOnce(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () => root?.render(<Probe />))
    expect(state?.inventory?.eligibleUpdateNames).toEqual(['orca-cli'])

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(freshnessInventory).toHaveBeenCalledTimes(1)
    expect(state?.inventory).toBeNull()
    expect(state?.loading).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(freshnessInventory).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(inventory(2)))
    expect(state?.inventory?.scannedAt).toBe(2)
  })

  it('coalesces multiple consumers into one rescan per invalidation event', async () => {
    const first = deferred<SkillFreshnessInventory>()
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () =>
      root?.render(
        <>
          <Probe />
          <Probe />
        </>
      )
    )
    await act(async () => first.resolve(inventory(1)))
    expect(freshnessInventory).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    await act(async () => second.resolve(inventory(2)))
    expect(freshnessInventory).toHaveBeenCalledTimes(2)
  })

  it('publishes a manual refresh to every consumer', async () => {
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockResolvedValueOnce(inventory(1))
      .mockReturnValueOnce(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () =>
      root?.render(
        <>
          <Probe id="one" />
          <Probe id="two" />
        </>
      )
    )
    expect(states.get('one')?.inventory?.scannedAt).toBe(1)
    expect(states.get('two')?.inventory?.scannedAt).toBe(1)

    let refresh: Promise<void> | undefined
    await act(async () => {
      refresh = states.get('one')?.refresh()
      await Promise.resolve()
    })
    expect(states.get('one')?.inventory).toBeNull()
    expect(states.get('two')?.inventory).toBeNull()

    await act(async () => second.resolve(inventory(2)))
    await refresh
    expect(states.get('one')?.inventory?.scannedAt).toBe(2)
    expect(states.get('two')?.inventory?.scannedAt).toBe(2)
    expect(freshnessInventory).toHaveBeenCalledTimes(2)
  })

  it('fails closed when an invalidation scan rejects', async () => {
    const second = deferred<SkillFreshnessInventory>()
    const freshnessInventory = vi
      .fn()
      .mockResolvedValueOnce(inventory(1))
      .mockReturnValueOnce(second.promise)
    window.api = { skills: { freshnessInventory } } as never

    await act(async () => root?.render(<Probe />))
    expect(state?.inventory?.scannedAt).toBe(1)

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    expect(state?.inventory).toBeNull()
    expect(state?.loading).toBe(true)

    await act(async () => second.reject(new Error('scan failed')))
    expect(state?.inventory).toBeNull()
    expect(state?.loading).toBe(false)
    expect(state?.error).toBe('scan failed')
  })

  it('installs one event-listener pair for multiple consumers and cleans it up', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    window.api = {
      skills: { freshnessInventory: vi.fn().mockResolvedValue(inventory(1)) }
    } as never

    await act(async () =>
      root?.render(
        <>
          <Probe id="one" />
          <Probe id="two" />
        </>
      )
    )

    expect(addEventListener.mock.calls.filter(([name]) => name === 'focus')).toHaveLength(1)
    expect(
      addEventListener.mock.calls.filter(([name]) => name === 'orca:installed-agent-skills-changed')
    ).toHaveLength(1)

    await act(async () => root?.unmount())
    root = null
    expect(removeEventListener.mock.calls.filter(([name]) => name === 'focus')).toHaveLength(1)
    expect(
      removeEventListener.mock.calls.filter(
        ([name]) => name === 'orca:installed-agent-skills-changed'
      )
    ).toHaveLength(1)
  })
})
