import { describe, expect, it, vi } from 'vitest'
import {
  getNextSourceControlViewMode,
  requestSourceControlViewModePreferenceWrite,
  type SourceControlViewModePreferenceWriteState
} from './source-control-view-mode'

describe('source control view mode helpers', () => {
  it('toggles between list and tree', () => {
    expect(getNextSourceControlViewMode('list')).toBe('tree')
    expect(getNextSourceControlViewMode('tree')).toBe('list')
  })

  it('does not persist the fallback list mode before settings hydrate', () => {
    const writeState: SourceControlViewModePreferenceWriteState = {
      writeChain: Promise.resolve(),
      writeSeq: 0
    }
    const setOptimisticMode = vi.fn()
    const updateSettings = vi.fn()

    const result = requestSourceControlViewModePreferenceWrite({
      hydrated: false,
      currentMode: 'list',
      writeState,
      setOptimisticMode,
      updateSettings
    })

    expect(result).toBeNull()
    expect(setOptimisticMode).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('queues rapid toggle writes so the last intent clears optimistic state', async () => {
    const writeState: SourceControlViewModePreferenceWriteState = {
      writeChain: Promise.resolve(),
      writeSeq: 0
    }
    const optimisticModes: ('list' | 'tree' | null)[] = []
    const firstWrite: { resolve: (() => void) | null } = { resolve: null }
    const updateSettings = vi.fn(
      ({ sourceControlViewMode }: { sourceControlViewMode: 'list' | 'tree' }) => {
        if (sourceControlViewMode === 'tree') {
          return new Promise<void>((resolve) => {
            firstWrite.resolve = resolve
          })
        }
        return Promise.resolve()
      }
    )

    expect(
      requestSourceControlViewModePreferenceWrite({
        hydrated: true,
        currentMode: 'list',
        writeState,
        setOptimisticMode: (mode) => optimisticModes.push(mode),
        updateSettings
      })
    ).toBe('tree')
    await Promise.resolve()

    expect(
      requestSourceControlViewModePreferenceWrite({
        hydrated: true,
        currentMode: 'tree',
        writeState,
        setOptimisticMode: (mode) => optimisticModes.push(mode),
        updateSettings
      })
    ).toBe('list')
    await Promise.resolve()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceControlViewMode: 'tree' })

    expect(firstWrite.resolve).not.toBeNull()
    firstWrite.resolve?.()
    await writeState.writeChain
    await Promise.resolve()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceControlViewMode: 'list' })
    expect(optimisticModes).toEqual(['tree', 'list', null])
  })
})
