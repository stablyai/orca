// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppearanceSettingsDraft } from './use-appearance-settings-draft'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('useAppearanceSettingsDraft', () => {
  it('stages effective settings without persisting them', () => {
    const settings = getDefaultSettings('/tmp')
    const persistSettings = vi.fn(async (): Promise<void> => {})
    const applyTheme = vi.fn()
    const hook = renderHook(() =>
      useAppearanceSettingsDraft({ settings, persistSettings, applyTheme })
    )

    act(() => hook.result.current.stage({ terminalFontSize: 18 }))

    expect(hook.result.current.settings?.terminalFontSize).toBe(18)
    expect(hook.result.current.changedKeys).toEqual(['terminalFontSize'])
    expect(hook.result.current.hasChanges).toBe(true)
    expect(persistSettings).not.toHaveBeenCalled()
    expect(applyTheme).not.toHaveBeenCalled()
  })

  it('saves multiple staged fields as one patch before applying the theme', async () => {
    const settings = getDefaultSettings('/tmp')
    const persistence = deferred<void>()
    const persistSettings = vi.fn(() => persistence.promise)
    const applyTheme = vi.fn()
    const hook = renderHook(() =>
      useAppearanceSettingsDraft({ settings, persistSettings, applyTheme })
    )

    act(() => {
      hook.result.current.stage({ theme: 'dark' })
      hook.result.current.stage({ terminalFontSize: 16 })
    })

    let savePromise!: Promise<boolean>
    act(() => {
      savePromise = hook.result.current.save()
    })

    expect(persistSettings).toHaveBeenCalledOnce()
    expect(persistSettings).toHaveBeenCalledWith({ theme: 'dark', terminalFontSize: 16 })
    expect(applyTheme).not.toHaveBeenCalled()
    expect(hook.result.current.saving).toBe(true)

    await act(async () => {
      persistence.resolve(undefined)
      await savePromise
    })

    expect(applyTheme).toHaveBeenCalledOnce()
    expect(applyTheme).toHaveBeenCalledWith('dark')
    expect(hook.result.current.hasChanges).toBe(false)
    expect(hook.result.current.saving).toBe(false)
  })

  it('discards all staged fields', () => {
    const settings = getDefaultSettings('/tmp')
    const hook = renderHook(() =>
      useAppearanceSettingsDraft({
        settings,
        persistSettings: vi.fn(async (): Promise<void> => {}),
        applyTheme: vi.fn()
      })
    )

    act(() => hook.result.current.stage({ theme: 'dark', terminalFontSize: 20 }))
    act(() => hook.result.current.discard())

    expect(hook.result.current.settings).toEqual(settings)
    expect(hook.result.current.changedKeys).toEqual([])
    expect(hook.result.current.hasChanges).toBe(false)
  })

  it('preserves the draft and reports a failed save', async () => {
    const settings = getDefaultSettings('/tmp')
    const error = new Error('write failed')
    const persistSettings = vi.fn(async (): Promise<void> => {
      throw error
    })
    const applyTheme = vi.fn()
    const hook = renderHook(() =>
      useAppearanceSettingsDraft({ settings, persistSettings, applyTheme })
    )

    act(() => hook.result.current.stage({ theme: 'dark' }))
    await act(async () => {
      await expect(hook.result.current.save()).rejects.toBe(error)
    })

    expect(hook.result.current.settings?.theme).toBe('dark')
    expect(hook.result.current.changedKeys).toEqual(['theme'])
    expect(hook.result.current.hasChanges).toBe(true)
    expect(hook.result.current.saveFailed).toBe(true)
    expect(hook.result.current.saving).toBe(false)
    expect(applyTheme).not.toHaveBeenCalled()
  })

  it('merges external base updates without overwriting dirty fields', () => {
    const initialSettings = getDefaultSettings('/tmp')
    const persistSettings = vi.fn(async (): Promise<void> => {})
    const applyTheme = vi.fn()
    const hook = renderHook(
      ({ settings }: { settings: GlobalSettings }) =>
        useAppearanceSettingsDraft({ settings, persistSettings, applyTheme }),
      { initialProps: { settings: initialSettings } }
    )

    act(() => hook.result.current.stage({ theme: 'dark' }))
    hook.rerender({
      settings: { ...initialSettings, theme: 'light', terminalFontSize: 19 }
    })

    expect(hook.result.current.settings?.theme).toBe('dark')
    expect(hook.result.current.settings?.terminalFontSize).toBe(19)
    expect(hook.result.current.changedKeys).toEqual(['theme'])
  })

  it('shares one persistence operation between concurrent saves', async () => {
    const settings = getDefaultSettings('/tmp')
    const persistence = deferred<void>()
    const persistSettings = vi.fn(() => persistence.promise)
    const hook = renderHook(() =>
      useAppearanceSettingsDraft({ settings, persistSettings, applyTheme: vi.fn() })
    )

    act(() => hook.result.current.stage({ terminalFontSize: 17 }))

    let firstSave!: Promise<boolean>
    let secondSave!: Promise<boolean>
    act(() => {
      firstSave = hook.result.current.save()
      secondSave = hook.result.current.save()
    })

    expect(secondSave).toBe(firstSave)
    expect(persistSettings).toHaveBeenCalledOnce()

    await act(async () => {
      persistence.resolve(undefined)
      await firstSave
    })

    expect(hook.result.current.hasChanges).toBe(false)
    expect(hook.result.current.saving).toBe(false)
  })

  it('rebases a same-field edit made while saving onto the persisted value', async () => {
    const settings = getDefaultSettings('/tmp')
    const originalFontSize = settings.terminalFontSize
    const persistence = deferred<void>()
    const persistSettings = vi.fn(() => persistence.promise)
    const applyTheme = vi.fn()
    const hook = renderHook(
      ({ currentSettings }: { currentSettings: GlobalSettings }) =>
        useAppearanceSettingsDraft({
          settings: currentSettings,
          persistSettings,
          applyTheme
        }),
      { initialProps: { currentSettings: settings } }
    )

    act(() => hook.result.current.stage({ terminalFontSize: originalFontSize + 2 }))
    let savePromise!: Promise<boolean>
    act(() => {
      savePromise = hook.result.current.save()
    })
    act(() => hook.result.current.stage({ terminalFontSize: originalFontSize }))
    hook.rerender({
      currentSettings: { ...settings, terminalFontSize: originalFontSize + 2 }
    })

    let cleanAfterSave = true
    await act(async () => {
      persistence.resolve(undefined)
      cleanAfterSave = await savePromise
    })

    expect(cleanAfterSave).toBe(false)
    expect(hook.result.current.settings?.terminalFontSize).toBe(originalFontSize)
    expect(hook.result.current.changedKeys).toEqual(['terminalFontSize'])
  })
})
