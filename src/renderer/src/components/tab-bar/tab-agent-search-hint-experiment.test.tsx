// @vitest-environment happy-dom
import { StrictMode, useState, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOncePerInstallHint } from '@/hooks/use-once-per-install-hint'
import { track } from '@/lib/telemetry'
import {
  createTabAgentSearchHintExperiment,
  getTabAgentSearchHintCohort
} from './tab-agent-search-hint-experiment'

const ready = vi.hoisted(() => ({ persistedUIReady: true }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof ready) => unknown) => selector(ready)
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
const key = 'orca.tabAgentSearchHint.v1'

function assignByte(byte: number) {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (array instanceof Uint8Array) {
      array.fill(byte)
    }
    return array
  })
}
function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>
}

function useHint(eligible: boolean) {
  const [experiment] = useState(createTabAgentSearchHintExperiment)
  return useOncePerInstallHint(eligible, experiment.claimHint)
}

describe('agent search hint experiment', () => {
  beforeEach(() => {
    localStorage.removeItem(key)
    vi.clearAllMocks()
    ready.persistedUIReady = true
  })
  afterEach(() => {
    localStorage.removeItem(key)
    vi.restoreAllMocks()
  })

  it.each([0, 127, 128, 255])('assigns each half of the random byte range once (%i)', (byte) => {
    assignByte(byte)
    const treatment = byte >= 128
    const first = renderHook(() => useHint(true), {
      wrapper
    })
    expect(first.result.current.hintOpen).toBe(treatment)
    expect(getTabAgentSearchHintCohort()).toBe(treatment ? 'treatment' : 'control')
    first.unmount()
    const second = renderHook(() => useHint(true))
    expect(second.result.current.hintOpen).toBe(false)
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledExactlyOnceWith('tab_agent_search_hint_exposure', {
      experiment_cohort: treatment ? 'treatment' : 'control'
    })
    second.unmount()
  })

  it('waits for ready and eligible UI, then never reopens after dismissal', () => {
    assignByte(255)
    ready.persistedUIReady = false
    const hint = renderHook(({ eligible }) => useHint(eligible), {
      initialProps: { eligible: false }
    })
    expect(localStorage.getItem(key)).toBeNull()
    ready.persistedUIReady = true
    hint.rerender({ eligible: false })
    expect(localStorage.getItem(key)).toBeNull()
    hint.rerender({ eligible: true })
    expect(hint.result.current.hintOpen).toBe(true)
    act(() => hint.result.current.dismissHint())
    hint.rerender({ eligible: false })
    hint.rerender({ eligible: true })
    expect(hint.result.current.hintOpen).toBe(false)
    hint.unmount()
  })

  it('stays closed when an exposed surface becomes eligible again', () => {
    assignByte(255)
    const hint = renderHook(({ eligible }) => useHint(eligible), {
      initialProps: { eligible: true },
      wrapper
    })
    expect(hint.result.current.hintOpen).toBe(true)
    hint.rerender({ eligible: false })
    expect(hint.result.current.hintOpen).toBe(false)
    hint.rerender({ eligible: true })
    expect(hint.result.current.hintOpen).toBe(false)
    hint.unmount()
  })

  it('suppresses the hint and actions when durable storage is unavailable', () => {
    assignByte(255)
    vi.spyOn(window, 'localStorage', 'get').mockImplementationOnce(() => {
      throw new Error('blocked')
    })
    const experiment = createTabAgentSearchHintExperiment()
    expect(experiment.claimHint()).toBe(false)
    experiment.trackAction('agent_selected')
    expect(track).not.toHaveBeenCalled()
  })

  it.each([0, 255])('measures only the first selection in the exposing session (%i)', (byte) => {
    assignByte(byte)
    const experiment = createTabAgentSearchHintExperiment()
    experiment.trackAction('agent_selected')
    expect(track).not.toHaveBeenCalled()

    experiment.claimHint()
    experiment.trackAction('agent_selected')
    experiment.trackAction('agent_selected')

    const experiment_cohort = byte >= 128 ? 'treatment' : 'control'
    expect(vi.mocked(track).mock.calls).toEqual([
      ['tab_agent_search_hint_exposure', { experiment_cohort }],
      ['tab_agent_search_hint_action', { experiment_cohort, action: 'agent_selected' }]
    ])
  })

  it('does not attribute another menu session to a stored cohort', () => {
    assignByte(255)
    const exposingSession = createTabAgentSearchHintExperiment()
    const otherSession = createTabAgentSearchHintExperiment()
    exposingSession.claimHint()
    vi.mocked(track).mockClear()

    expect(otherSession.claimHint()).toBe(false)
    otherSession.trackAction('agent_selected')
    expect(track).not.toHaveBeenCalled()

    exposingSession.trackAction('try_example')
    exposingSession.trackAction('agent_selected')
    expect(vi.mocked(track).mock.calls).toEqual([
      ['tab_agent_search_hint_action', { experiment_cohort: 'treatment', action: 'try_example' }],
      ['tab_agent_search_hint_action', { experiment_cohort: 'treatment', action: 'agent_selected' }]
    ])
  })
})
