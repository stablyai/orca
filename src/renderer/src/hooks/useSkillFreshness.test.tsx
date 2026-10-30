// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { planOf, sharedEntry } from '../components/skills/bundled-skill-plan-fixtures.test-support'
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

function digest(id: number): string {
  return String(id).padStart(64, '0')
}

function plan(id: number, updates: string[] = []): BundledSkillPlan {
  return planOf(
    updates.map((name) => sharedEntry(name, 'update')),
    digest(id)
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let state: SkillFreshnessState | null = null
const states = new Map<string, SkillFreshnessState>()
const renderedPlans: (BundledSkillPlan | null)[] = []

const LOCAL: BundledSkillTarget = { kind: 'local' }

function Probe({
  id = 'default',
  enabled = true,
  target = LOCAL
}: {
  id?: string
  enabled?: boolean
  target?: BundledSkillTarget
}): null {
  state = useSkillFreshness(enabled ? target : null)
  states.set(id, state)
  renderedPlans.push(state.plan)
  return null
}

function installBundledPlan(bundledPlan: Window['api']['skills']['bundledPlan']): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only skills.bundledPlan on the preload API.
  window.api = { skills: { bundledPlan } } as unknown as Window['api']
}

describe('useSkillFreshness', () => {
  beforeEach(() => {
    _skillFreshnessCacheForTests.reset()
    state = null
    states.clear()
    renderedPlans.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('runs a follow-up plan when invalidated during an in-flight request', async () => {
    const first = deferred<BundledSkillPlan>()
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe />))
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => first.resolve(plan(1)))
    expect(bundledPlan).toHaveBeenCalledTimes(2)

    await act(async () => second.resolve(plan(2)))
    expect(state?.plan?.planDigest).toBe(digest(2))
  })

  it('does not scan, subscribe, or refresh while local freshness is disabled', async () => {
    const bundledPlan = vi.fn().mockResolvedValue(plan(1))
    const addEventListener = vi.spyOn(window, 'addEventListener')
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe enabled={false} />))
    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    await act(async () => state?.refresh())

    expect(bundledPlan).not.toHaveBeenCalled()
    expect(state).toMatchObject({ plan: null, loading: false, error: null })
    expect(
      addEventListener.mock.calls.filter(
        ([name]) => name === 'focus' || name === 'orca:installed-agent-skills-changed'
      )
    ).toHaveLength(0)
  })

  it('forces one fresh scan before restoring authority after re-enable', async () => {
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi
      .fn()
      .mockResolvedValueOnce(plan(1, ['orca-cli']))
      .mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)
    const renderProbes = (enabled: boolean): void => {
      root?.render(
        <StrictMode>
          <Probe id="one" enabled={enabled} />
          <Probe id="two" enabled={enabled} />
        </StrictMode>
      )
    }

    await act(async () => renderProbes(true))
    expect(bundledPlan).toHaveBeenCalledTimes(1)
    expect(state?.plan?.skills.map((skill) => skill.name)).toEqual(['orca-cli'])

    await act(async () => renderProbes(true))
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => renderProbes(false))
    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    expect(bundledPlan).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({ plan: null, loading: false })

    const reenableRenderStart = renderedPlans.length
    await act(async () => renderProbes(true))
    expect(bundledPlan).toHaveBeenCalledTimes(2)
    expect(state).toMatchObject({ plan: null, loading: true })
    expect(renderedPlans.slice(reenableRenderStart).every((value) => value === null)).toBe(true)

    await act(async () => second.resolve(plan(2)))
    expect(state?.plan?.planDigest).toBe(digest(2))
    expect(state?.plan?.skills.map((skill) => skill.name)).toEqual([])
  })

  it('skips focus rescans inside the cooldown but honors install-change events', async () => {
    const first = deferred<BundledSkillPlan>()
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe />))
    await act(async () => first.resolve(plan(1)))
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    await act(async () => second.resolve(plan(2)))
    expect(bundledPlan).toHaveBeenCalledTimes(2)
    expect(state?.plan?.planDigest).toBe(digest(2))
  })

  it('retracts stale update authority during the cooldown and runs one trailing focus scan', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi
      .fn()
      .mockResolvedValueOnce(plan(1, ['orca-cli']))
      .mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe />))
    expect(state?.plan?.skills.map((skill) => skill.name)).toEqual(['orca-cli'])

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(bundledPlan).toHaveBeenCalledTimes(1)
    expect(state?.plan).toBeNull()
    expect(state?.loading).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(bundledPlan).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(plan(2)))
    expect(state?.plan?.planDigest).toBe(digest(2))
  })

  it('coalesces multiple consumers into one rescan per invalidation event', async () => {
    const first = deferred<BundledSkillPlan>()
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () =>
      root?.render(
        <>
          <Probe />
          <Probe />
        </>
      )
    )
    await act(async () => first.resolve(plan(1)))
    expect(bundledPlan).toHaveBeenCalledTimes(1)

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    await act(async () => second.resolve(plan(2)))
    expect(bundledPlan).toHaveBeenCalledTimes(2)
  })

  it('publishes a manual refresh to every consumer', async () => {
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi.fn().mockResolvedValueOnce(plan(1)).mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () =>
      root?.render(
        <>
          <Probe id="one" />
          <Probe id="two" />
        </>
      )
    )
    expect(states.get('one')?.plan?.planDigest).toBe(digest(1))
    expect(states.get('two')?.plan?.planDigest).toBe(digest(1))

    let refresh: Promise<void> | undefined
    await act(async () => {
      refresh = states.get('one')?.refresh()
      await Promise.resolve()
    })
    expect(states.get('one')?.plan).toBeNull()
    expect(states.get('two')?.plan).toBeNull()

    await act(async () => second.resolve(plan(2)))
    await refresh
    expect(states.get('one')?.plan?.planDigest).toBe(digest(2))
    expect(states.get('two')?.plan?.planDigest).toBe(digest(2))
    expect(bundledPlan).toHaveBeenCalledTimes(2)
  })

  it('fails closed when an invalidation scan rejects', async () => {
    const second = deferred<BundledSkillPlan>()
    const bundledPlan = vi.fn().mockResolvedValueOnce(plan(1)).mockReturnValueOnce(second.promise)
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe />))
    expect(state?.plan?.planDigest).toBe(digest(1))

    await act(async () => window.dispatchEvent(new Event('orca:installed-agent-skills-changed')))
    expect(state?.plan).toBeNull()
    expect(state?.loading).toBe(true)

    await act(async () => second.reject(new Error('scan failed')))
    expect(state?.plan).toBeNull()
    expect(state?.loading).toBe(false)
    expect(state?.error).toBe('scan failed')
  })

  it('installs one event-listener pair for multiple consumers and cleans it up', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    installBundledPlan(vi.fn().mockResolvedValue(plan(1)))

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

  it('re-plans a new host without ever showing the previous host’s plan', async () => {
    const bundledPlan = vi.fn().mockResolvedValueOnce(plan(1, ['orca-cli']))
    installBundledPlan(bundledPlan)

    await act(async () => root?.render(<Probe />))
    expect(state?.plan?.planDigest).toBe(digest(1))

    await act(async () => root?.render(<Probe target={{ kind: 'ssh', targetId: 'box' }} />))
    expect(state).toMatchObject({ plan: null, loading: false, unsupported: 'connect-host' })
    expect(bundledPlan).toHaveBeenCalledTimes(1)
  })
})
