// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSetupGuidePane } from './SettingsSetupGuidePane'

const { toastError, renderChecklist } = vi.hoisted(() => ({
  toastError: vi.fn(),
  renderChecklist: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError } }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./settings-setup-guide-progress', () => ({
  useSettingsSetupGuideFullProgress: () => ({ stepDone: {} })
}))

vi.mock('../feature-wall/FeatureWallSetupChecklist', () => ({
  FeatureWallSetupChecklist: () => {
    renderChecklist()
    return <div role="region" aria-label="Setup steps" />
  }
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('SettingsSetupGuidePane', () => {
  const originalApi = window.api
  const getUI = vi.fn()
  const setUI = vi.fn()

  beforeEach(() => {
    getUI.mockReset().mockResolvedValue({ setupGuideSettingsDismissed: false })
    setUI.mockReset().mockResolvedValue(undefined)
    toastError.mockReset()
    renderChecklist.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.assign(window, { api: { ui: { get: getUI, set: setUI } } })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Object.assign(window, { api: originalApi })
  })

  it('never mounts a persisted hidden checklist while its preference is loading', async () => {
    const load = deferred<{ setupGuideSettingsDismissed: boolean }>()
    getUI.mockReturnValue(load.promise)
    render(<SettingsSetupGuidePane />)

    expect(screen.getByRole('status', { name: 'Loading onboarding checklist' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Setup steps' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide checklist' })).toBeNull()

    await act(async () => {
      load.resolve({ setupGuideSettingsDismissed: true })
    })

    expect(screen.getByRole('button', { name: 'Show checklist' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(renderChecklist).not.toHaveBeenCalled()
    expect(setUI).not.toHaveBeenCalled()
  })

  it('persists both hide and show choices and restores them when reopened', async () => {
    let dismissed = false
    getUI.mockImplementation(async () => ({ setupGuideSettingsDismissed: dismissed }))
    setUI.mockImplementation(async (update: { setupGuideSettingsDismissed: boolean }) => {
      dismissed = update.setupGuideSettingsDismissed
    })
    const firstOpen = render(<SettingsSetupGuidePane />)

    fireEvent.click(await screen.findByRole('button', { name: 'Hide checklist' }))
    await screen.findByRole('button', { name: 'Show checklist' })
    expect(setUI).toHaveBeenNthCalledWith(1, { setupGuideSettingsDismissed: true })
    expect(screen.queryByRole('region', { name: 'Setup steps' })).toBeNull()

    firstOpen.unmount()
    const secondOpen = render(<SettingsSetupGuidePane />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show checklist' }))
    await screen.findByRole('region', { name: 'Setup steps' })
    expect(setUI).toHaveBeenNthCalledWith(2, { setupGuideSettingsDismissed: false })

    secondOpen.unmount()
    render(<SettingsSetupGuidePane />)
    expect(await screen.findByRole('button', { name: 'Hide checklist' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Setup steps' })).toBeTruthy()
    expect(getUI).toHaveBeenCalledTimes(3)
    expect(setUI).toHaveBeenCalledTimes(2)
  })

  it('keeps the checklist visible and prevents duplicate clicks until hiding is saved', async () => {
    const save = deferred<void>()
    setUI.mockReturnValue(save.promise)
    render(<SettingsSetupGuidePane />)
    const hide = await screen.findByRole<HTMLButtonElement>('button', { name: 'Hide checklist' })

    fireEvent.click(hide)
    expect(hide.disabled).toBe(true)
    expect(screen.getByRole('region', { name: 'Setup steps' })).toBeTruthy()
    fireEvent.click(hide)
    expect(setUI).toHaveBeenCalledTimes(1)

    await act(async () => {
      save.resolve()
    })

    expect(screen.getByRole('button', { name: 'Show checklist' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Setup steps' })).toBeNull()
  })

  it.each([
    { dismissed: false, action: 'Hide checklist' },
    { dismissed: true, action: 'Show checklist' }
  ])('retains the current state when "$action" cannot be saved', async ({ dismissed, action }) => {
    getUI.mockResolvedValue({ setupGuideSettingsDismissed: dismissed })
    setUI.mockRejectedValueOnce(new Error('Connection lost'))
    render(<SettingsSetupGuidePane />)
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: action })

    fireEvent.click(button)

    await waitFor(() => expect(button.disabled).toBe(false))
    expect(setUI).toHaveBeenCalledWith({ setupGuideSettingsDismissed: !dismissed })
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: action })).toBe(button)
    expect(screen.queryByRole('region', { name: 'Setup steps' }) !== null).toBe(!dismissed)

    fireEvent.click(button)
    await screen.findByRole('button', {
      name: dismissed ? 'Hide checklist' : 'Show checklist'
    })
    expect(setUI).toHaveBeenCalledTimes(2)
  })

  it('retries a failed preference read without revealing a hidden checklist', async () => {
    const retry = deferred<{ setupGuideSettingsDismissed: boolean }>()
    getUI.mockRejectedValueOnce(new Error('Connection lost')).mockReturnValueOnce(retry.promise)
    render(<SettingsSetupGuidePane />)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(screen.getByRole('status', { name: 'Loading onboarding checklist' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Setup steps' })).toBeNull()

    await act(async () => {
      retry.resolve({ setupGuideSettingsDismissed: true })
    })

    expect(screen.getByRole('button', { name: 'Show checklist' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(renderChecklist).not.toHaveBeenCalled()
    expect(getUI).toHaveBeenCalledTimes(2)
    expect(setUI).not.toHaveBeenCalled()
  })

  it.each([
    { dismissed: false, action: 'Hide checklist' },
    { dismissed: true, action: 'Show checklist' }
  ])('requires host acknowledgement when saving "$action"', async ({ dismissed, action }) => {
    getUI.mockResolvedValue({ setupGuideSettingsDismissed: dismissed })
    const retry = deferred<void>()
    const setWithAck = vi
      .fn()
      .mockRejectedValueOnce(new Error('Host unavailable'))
      .mockReturnValueOnce(retry.promise)
    Object.assign(window.api.ui, { setWithAck })
    render(<SettingsSetupGuidePane />)
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: action })

    fireEvent.click(button)

    await waitFor(() => expect(button.disabled).toBe(false))
    expect(setWithAck).toHaveBeenCalledWith({ setupGuideSettingsDismissed: !dismissed })
    expect(toastError).toHaveBeenCalledWith('Could not save checklist visibility. Try again.')
    expect(screen.getByRole('button', { name: action })).toBe(button)
    expect(screen.queryByRole('region', { name: 'Setup steps' }) !== null).toBe(!dismissed)
    expect(setUI).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    expect(screen.queryByRole('region', { name: 'Setup steps' }) !== null).toBe(!dismissed)

    await act(async () => {
      retry.resolve()
    })

    expect(
      screen.getByRole('button', { name: dismissed ? 'Hide checklist' : 'Show checklist' })
    ).toBeTruthy()
    expect(setWithAck).toHaveBeenCalledTimes(2)
    expect(setUI).not.toHaveBeenCalled()
  })
})
