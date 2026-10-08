import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../../../shared/constants'

const initialState = useAppStore.getInitialState()

function seed(overrides: Partial<AppState>): ReturnType<typeof vi.fn> {
  const updateSettings = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), compactProjectRows: false },
    projectOrderBy: 'recent',
    attentionProjectOrderRestore: null,
    updateSettings,
    ...overrides
  })
  return updateSettings
}

describe('attention project order actions', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('switches to attention with compact rows, then restores both', () => {
    const updateSettings = seed({})
    useAppStore.getState().toggleAttentionProjectOrder()
    expect(useAppStore.getState().projectOrderBy).toBe('attention')
    expect(updateSettings).toHaveBeenLastCalledWith({ compactProjectRows: true })

    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), compactProjectRows: true }
    })
    useAppStore.getState().toggleAttentionProjectOrder()
    expect(useAppStore.getState().projectOrderBy).toBe('recent')
    expect(updateSettings).toHaveBeenLastCalledWith({ compactProjectRows: false })
    expect(useAppStore.getState().attentionProjectOrderRestore).toBeNull()
  })

  it('drops the restore point when the project order is chosen directly', () => {
    seed({})
    useAppStore.getState().toggleAttentionProjectOrder()
    useAppStore.getState().setProjectOrderBy('attention')
    expect(useAppStore.getState().attentionProjectOrderRestore).toBeNull()
  })

  it('drops the restore point when compact rows are set directly', () => {
    const updateSettings = seed({})
    useAppStore.getState().toggleAttentionProjectOrder()
    useAppStore.getState().setCompactProjectRows(true)
    expect(useAppStore.getState().attentionProjectOrderRestore).toBeNull()
    expect(updateSettings).toHaveBeenLastCalledWith({ compactProjectRows: true })

    // Why: with no restore point, turning the toggle off keeps the user's compact choice.
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), compactProjectRows: true }
    })
    updateSettings.mockClear()
    useAppStore.getState().toggleAttentionProjectOrder()
    expect(useAppStore.getState().projectOrderBy).toBe('manual')
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
