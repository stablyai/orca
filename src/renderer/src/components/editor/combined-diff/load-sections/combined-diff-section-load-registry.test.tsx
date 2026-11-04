// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'

afterEach(cleanup)

describe('combined diff section load registry', () => {
  it('loads up to three rendered sections at once and refills freed slots', async () => {
    const sections = Array.from({ length: 6 }, (_, index): DiffSection => ({
      key: `s${index}`,
      path: `f${index}.ts`,
      status: 'modified',
      originalContent: '',
      modifiedContent: '',
      collapsed: false,
      loading: true,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null
    }))
    const { result } = renderHook(() => useCombinedDiffSectionLoadRegistry(sections))
    const registry = result.current
    registry.renderedIndicesRef.current = new Set([0, 1, 2, 3, 4, 5])
    const started: number[] = []
    const finishers = new Map<number, () => void>()
    registry.loadSectionRef.current = (index) =>
      new Promise<void>((resolve) => {
        started.push(index)
        finishers.set(index, resolve)
      })

    await act(async () => {
      for (const index of [0, 1, 2, 3, 4, 5]) {
        registry.loadSchedulerRef.current.request(index, { viewportOnly: true })
      }
    })
    expect(started).toEqual([0, 1, 2])

    await act(async () => {
      finishers.get(1)?.()
    })
    expect(started).toEqual([0, 1, 2, 3])
  })
})
