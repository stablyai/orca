// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, useRef } from 'react'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionRetry } from './use-combined-diff-section-retry'

function section(overrides: Partial<DiffSection> = {}): DiffSection {
  return {
    key: 'file.ts',
    path: 'file.ts',
    status: 'modified',
    area: 'unstaged',
    originalContent: 'original',
    modifiedContent: 'original',
    dirty: false,
    collapsed: false,
    loading: false,
    largeDiffRenderLimit: null,
    contentGeneration: 1,
    ...overrides
  } as DiffSection
}

const invalidate = vi.fn()
function setup(initial: DiffSection[]) {
  return renderHook(() => {
    const sectionsRef = useRef(initial)
    const registry = useCombinedDiffSectionLoadRegistry(sectionsRef)
    const actions = useCombinedDiffSectionRetry({
      invalidateViewStateCache: invalidate,
      registry,
      setSectionHeights: vi.fn(),
      setSections: vi.fn()
    })
    registry.renderedIndicesRef.current.add(0)
    return { actions, registry, sectionsRef }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deferred section reloads', () => {
  it('does nothing on a row that never refused a reload, so a plain save costs no git diff', () => {
    const view = setup([section()])
    act(() => view.result.current.actions.retryDeferredSectionReload(0))
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('re-drives only the row whose reload was refused while dirty', () => {
    const view = setup([section({ dirty: true }), section({ key: 'other.ts', path: 'other.ts' })])
    act(() => view.result.current.actions.requestSectionReload(0))
    expect(invalidate).not.toHaveBeenCalled()
    act(() => view.result.current.actions.retryDeferredSectionReload(1))
    expect(invalidate).not.toHaveBeenCalled()
    view.result.current.sectionsRef.current[0] = section()
    act(() => view.result.current.actions.retryDeferredSectionReload(0))
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('clears the record once the reload runs, so it fires once per refusal', () => {
    const view = setup([section({ dirty: true })])
    act(() => view.result.current.actions.requestSectionReload(0))
    view.result.current.sectionsRef.current[0] = section()
    act(() => view.result.current.actions.retryDeferredSectionReload(0))
    act(() => view.result.current.actions.retryDeferredSectionReload(0))
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('ignores a reload requested after the viewer unmounts', () => {
    const view = setup([section()])
    view.unmount()
    act(() => view.result.current.actions.requestSectionReload(0))
    expect(invalidate).not.toHaveBeenCalled()
  })
})

it('still reloads after StrictMode replays the registry effect', () => {
  // Why: StrictMode runs setup -> cleanup -> setup with no render between the two setups, so a
  // render-only live flag stays false for the life of the replayed mount.
  const view = renderHook(
    () => {
      const sectionsRef = useRef([section()])
      const registry = useCombinedDiffSectionLoadRegistry(sectionsRef)
      const actions = useCombinedDiffSectionRetry({
        invalidateViewStateCache: invalidate,
        registry,
        setSectionHeights: vi.fn(),
        setSections: vi.fn()
      })
      registry.renderedIndicesRef.current.add(0)
      return actions
    },
    { wrapper: StrictMode }
  )
  act(() => view.result.current.requestSectionReload(0))
  expect(invalidate).toHaveBeenCalled()
})
