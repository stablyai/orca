// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLD_PARKED_PRESENTATION_FALLBACK_MS,
  useColdParkedTerminalPresentation
} from './use-cold-parked-terminal-presentation'

type HookProps = {
  desiredTargetId: string | null
  coldParkedTargetIds: ReadonlySet<string>
}

const availableTargetIds = new Set(['a', 'b', 'c'])

function renderPresentationHook(initialProps: HookProps) {
  return renderHook(
    ({ desiredTargetId, coldParkedTargetIds }: HookProps) =>
      useColdParkedTerminalPresentation({
        desiredTargetByScope: new Map([['scope', desiredTargetId]]),
        coldParkedTargetIds,
        availableTargetIds
      }),
    { initialProps }
  )
}

function presentedTargetId(
  result: ReturnType<typeof renderPresentationHook>['result']
): string | null | undefined {
  return result.current.presentationByScope.get('scope')?.presentedTargetId
}

describe('useColdParkedTerminalPresentation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('presents a warm target immediately', () => {
    const hook = renderPresentationHook({
      desiredTargetId: 'a',
      coldParkedTargetIds: new Set()
    })

    hook.rerender({ desiredTargetId: 'b', coldParkedTargetIds: new Set() })

    expect(presentedTargetId(hook.result)).toBe('b')
  })

  it('retains the prior target until a cold target settles', () => {
    const hook = renderPresentationHook({
      desiredTargetId: 'a',
      coldParkedTargetIds: new Set()
    })

    hook.rerender({ desiredTargetId: 'b', coldParkedTargetIds: new Set(['b']) })
    hook.rerender({ desiredTargetId: 'b', coldParkedTargetIds: new Set() })

    expect(presentedTargetId(hook.result)).toBe('a')
    act(() => hook.result.current.settleTarget('b'))
    expect(presentedTargetId(hook.result)).toBe('b')
  })

  it('ignores a stale settle after another switch', () => {
    const hook = renderPresentationHook({
      desiredTargetId: 'a',
      coldParkedTargetIds: new Set()
    })

    hook.rerender({ desiredTargetId: 'b', coldParkedTargetIds: new Set(['b']) })
    hook.rerender({ desiredTargetId: 'c', coldParkedTargetIds: new Set() })
    act(() => hook.result.current.settleTarget('b'))

    expect(presentedTargetId(hook.result)).toBe('c')
  })

  it('falls back when a cold target never settles', () => {
    vi.useFakeTimers()
    const hook = renderPresentationHook({
      desiredTargetId: 'a',
      coldParkedTargetIds: new Set()
    })

    hook.rerender({ desiredTargetId: 'b', coldParkedTargetIds: new Set(['b']) })
    act(() => vi.advanceTimersByTime(COLD_PARKED_PRESENTATION_FALLBACK_MS))

    expect(presentedTargetId(hook.result)).toBe('b')
  })
})
