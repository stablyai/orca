// @vitest-environment happy-dom
import { tmpdir } from 'node:os'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { create, useStore, type StoreApi } from 'zustand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Slider } from '../ui/slider'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppBackgroundApi } from '../../../../preload/api/app-background-api'
import {
  createAppBackgroundDraftActions,
  type AppBackgroundDraftHost
} from '../../store/slices/app-background-draft'

const holder = vi.hoisted(() => {
  const value: { store: StoreApi<AppBackgroundDraftHost> | null } = {
    store: null
  }
  return value
})

vi.mock('../../store', () => ({
  useAppStore: <T,>(selector: (state: AppBackgroundDraftHost) => T): T => {
    if (!holder.store) {
      throw new Error('test store not installed')
    }
    return useStore(holder.store, selector)
  }
}))
vi.mock('../ui/slider', () => ({
  Slider: ({
    value,
    min,
    max,
    step,
    disabled,
    thumbLabels,
    onValueChange
  }: ComponentProps<typeof Slider>) => (
    <input
      aria-label={thumbLabels?.[0]}
      disabled={disabled}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value?.[0]}
      onChange={(event) => onValueChange?.([Number(event.target.value)])}
    />
  )
}))

import { AppearanceBackgroundSection } from './AppearanceBackgroundSection'

const SAVED_ID = '11111111-1111-4111-8111-111111111111.png'
const STAGED_ID = '22222222-2222-4222-8222-222222222222.jpg'

function makeApi(overrides: Partial<AppBackgroundApi> = {}): AppBackgroundApi {
  return {
    pick: vi.fn(async () => ({ status: 'canceled' as const })),
    read: vi.fn(async () => new ArrayBuffer(8)),
    commit: vi.fn(async ({ stagingId }) => ({
      ok: true as const,
      imageId: stagingId
    })),
    discard: vi.fn(async () => {}),
    ...overrides
  }
}

function setup(settingsOverrides: Partial<GlobalSettings> = {}, api = makeApi()) {
  const updateSettingsOrThrow = vi.fn(async (updates: Partial<GlobalSettings>) => {
    store.setState((state) => ({
      settings: state.settings ? { ...state.settings, ...updates } : state.settings
    }))
  })
  const store = create<AppBackgroundDraftHost>()((set, get) => ({
    settings: { ...getDefaultSettings(tmpdir()), ...settingsOverrides },
    updateSettingsOrThrow,
    ...createAppBackgroundDraftActions(set, get, () => api)
  }))
  holder.store = store
  vi.stubGlobal('api', { appBackground: api })
  const renderSection = () =>
    render(<AppearanceBackgroundSection settings={store.getState().settings!} />)
  return { store, api, updateSettingsOrThrow, renderSection }
}

const unappliedBadge = () => screen.queryByText('Unapplied changes')

describe('AppearanceBackgroundSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:background')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('edits only the draft until Apply, then writes the changed settings', async () => {
    const { store, updateSettingsOrThrow, renderSection } = setup()
    renderSection()
    expect(unappliedBadge()).toBeNull()
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByRole('slider', { name: 'Image Opacity' }), {
      target: { value: '0.3' }
    })

    expect(store.getState().appBackgroundDraft?.imageOpacity).toBe(0.3)
    expect(store.getState().settings?.appBackgroundImageOpacity).toBe(1)
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(unappliedBadge()).not.toBeNull()
    expect(screen.getByText('30%')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })

    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({
      appBackgroundImageOpacity: 0.3
    })
    expect(store.getState().appBackgroundDraft).toBeNull()
    expect(unappliedBadge()).toBeNull()
  })

  it('writes terminal opacity through the draft into terminalBackgroundOpacity', async () => {
    const { updateSettingsOrThrow, renderSection } = setup({
      terminalBackgroundOpacity: 1
    })
    renderSection()
    fireEvent.change(screen.getByRole('slider', { name: 'Terminal Background Opacity' }), {
      target: { value: '0.5' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })
    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({
      terminalBackgroundOpacity: 0.5
    })
  })

  it('Discard restores the applied values and clears the unapplied marker', () => {
    const { store, updateSettingsOrThrow, renderSection } = setup()
    renderSection()
    fireEvent.click(screen.getByRole('radio', { name: 'Workspace only' }))
    expect(screen.getByRole('radio', { name: 'Workspace only' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(unappliedBadge()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(store.getState().appBackgroundDraft).toBeNull()
    expect(screen.getByRole('radio', { name: 'Entire window' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(unappliedBadge()).toBeNull()
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('keeps the draft when the section unmounts and remounts', () => {
    const { renderSection } = setup()
    const first = renderSection()
    fireEvent.change(screen.getByRole('slider', { name: 'Image Blur' }), {
      target: { value: '6' }
    })
    first.unmount()

    renderSection()
    expect(screen.getByText('6px')).toBeTruthy()
    expect(unappliedBadge()).not.toBeNull()
  })

  it('stages a picked image, previews it, and commits it on Apply', async () => {
    const api = makeApi({
      pick: vi.fn(async () => ({
        status: 'picked' as const,
        stagingId: STAGED_ID
      }))
    })
    const { store, renderSection } = setup({}, api)
    renderSection()
    expect(screen.getByTestId('app-background-preview').getAttribute('data-preview-scope')).toBe(
      'none'
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Choose Image/ }))
    })

    expect(store.getState().appBackgroundDraft?.image).toEqual({
      kind: 'staged',
      stagingId: STAGED_ID
    })
    expect(screen.getByText('New image selected.')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId('app-background-preview').getAttribute('data-preview-scope')).toBe(
        'window'
      )
    )
    expect(api.read).toHaveBeenCalledWith({ id: STAGED_ID, staging: true })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })
    expect(api.commit).toHaveBeenCalledExactlyOnceWith({
      stagingId: STAGED_ID
    })
    expect(store.getState().settings?.appBackgroundImageId).toBe(STAGED_ID)
  })

  it('shows a readable error when the picked file is rejected', async () => {
    const api = makeApi({
      pick: vi
        .fn<AppBackgroundApi['pick']>()
        .mockResolvedValueOnce({ status: 'rejected', reason: 'tooLarge' })
        .mockResolvedValueOnce({
          status: 'rejected',
          reason: 'unsupportedType'
        })
        .mockResolvedValueOnce({ status: 'canceled' })
    })
    const { store, renderSection } = setup({}, api)
    renderSection()
    const choose = screen.getByRole('button', { name: /Choose Image/ })

    await act(async () => {
      fireEvent.click(choose)
    })
    expect(screen.getByRole('alert').textContent).toContain('larger than 20 MB')

    await act(async () => {
      fireEvent.click(choose)
    })
    expect(screen.getByRole('alert').textContent).toContain('PNG, JPEG, GIF, or WebP')

    await act(async () => {
      fireEvent.click(choose)
    })
    // Why: canceling the dialog is not an error.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(store.getState().appBackgroundDraft).toBeNull()
  })

  it('shows an error and keeps the draft when Apply fails', async () => {
    const api = makeApi({
      pick: vi.fn(async () => ({
        status: 'picked' as const,
        stagingId: STAGED_ID
      })),
      commit: vi.fn(async () => ({
        ok: false as const,
        reason: 'stagingMissing' as const
      }))
    })
    const { store, renderSection } = setup({}, api)
    renderSection()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Choose Image/ }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })
    expect(screen.getByRole('alert').textContent).toContain('no longer available')
    expect(store.getState().appBackgroundDraft).not.toBeNull()
    expect(unappliedBadge()).not.toBeNull()
  })

  it('marks removal of the saved image as an unapplied change', () => {
    const { store, renderSection } = setup({ appBackgroundImageId: SAVED_ID })
    renderSection()
    expect(screen.getByText('Custom image in use.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(store.getState().appBackgroundDraft?.image).toEqual({
      kind: 'remove'
    })
    expect(screen.getByText('Image will be removed.')).toBeTruthy()
    expect(screen.getByTestId('app-background-preview').getAttribute('data-preview-scope')).toBe(
      'none'
    )
    expect(unappliedBadge()).not.toBeNull()
  })

  it('previews window scope on the whole frame and workspace scope on the workspace only', async () => {
    const { renderSection } = setup({ appBackgroundImageId: SAVED_ID })
    renderSection()
    const preview = screen.getByTestId('app-background-preview')
    const frame = preview.firstElementChild
    const workspace = screen.getByTestId('app-background-preview-workspace')
    await waitFor(() => expect(frame?.getAttribute('data-app-background')).toBe('window'))
    expect(workspace.hasAttribute('data-app-background')).toBe(false)

    fireEvent.click(screen.getByRole('radio', { name: 'Workspace only' }))

    expect(frame?.hasAttribute('data-app-background')).toBe(false)
    expect(workspace.getAttribute('data-app-background')).toBe('workspace')
    expect(preview.getAttribute('data-preview-scope')).toBe('workspace')
  })

  it('applies the draft panel opacity to the preview host', async () => {
    const { renderSection } = setup({ appBackgroundImageId: SAVED_ID })
    renderSection()
    await waitFor(() =>
      expect(screen.getByTestId('app-background-preview').getAttribute('data-preview-scope')).toBe(
        'window'
      )
    )
    fireEvent.change(screen.getByRole('slider', { name: 'Panel Opacity' }), {
      target: { value: '0.4' }
    })
    const frame = screen.getByTestId('app-background-preview').firstElementChild
    if (!(frame instanceof HTMLElement)) {
      throw new Error('expected preview frame')
    }
    expect(frame.style.getPropertyValue('--app-panel-opacity')).toBe('0.4')
  })

  it('reports a missing saved image, keeps the preview opaque, and lets the user remove it', async () => {
    const api = makeApi({ read: vi.fn(async () => null) })
    const { store, renderSection } = setup({ appBackgroundImageId: SAVED_ID }, api)
    renderSection()

    await waitFor(() =>
      expect(
        screen.getByText(
          'The background image could not be loaded. Choose another image or remove it.'
        )
      ).toBeTruthy()
    )
    expect(screen.queryByText('Custom image in use.')).toBeNull()
    expect(screen.getByTestId('app-background-preview').getAttribute('data-preview-scope')).toBe(
      'none'
    )

    const remove = screen.getByRole('button', { name: 'Remove' })
    expect(remove).toHaveProperty('disabled', false)
    fireEvent.click(remove)
    expect(store.getState().appBackgroundDraft?.image).toEqual({ kind: 'remove' })
  })

  it('shows settings changed elsewhere for fields the draft did not touch', () => {
    const { store, renderSection } = setup({ terminalBackgroundOpacity: 0.9 })
    const { rerender } = renderSection()
    fireEvent.change(screen.getByRole('slider', { name: 'Panel Opacity' }), {
      target: { value: '0.4' }
    })

    act(() => {
      store.setState((state) => ({
        settings: { ...state.settings!, terminalBackgroundOpacity: 0.3 }
      }))
    })
    rerender(<AppearanceBackgroundSection settings={store.getState().settings!} />)

    expect(
      screen.getByRole('slider', { name: 'Terminal Background Opacity' }).getAttribute('value')
    ).toBe('0.3')
    expect(store.getState().appBackgroundDraft).toMatchObject({
      panelOpacity: 0.4,
      terminalBackgroundOpacity: 0.3,
      snapshot: { terminalBackgroundOpacity: 0.3 }
    })
  })

  it('locks every control while Apply is in flight', async () => {
    let finishCommit: () => void = () => {}
    const api = makeApi({
      commit: vi.fn(
        () =>
          new Promise<{ ok: true; imageId: string }>((resolve) => {
            finishCommit = () => resolve({ ok: true, imageId: STAGED_ID })
          })
      )
    })
    const { store, renderSection } = setup({}, api)
    store.getState().stageAppBackgroundDraftImage(STAGED_ID)
    renderSection()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    })

    for (const name of [
      'Image Opacity',
      'Image Blur',
      'Panel Opacity',
      'Terminal Background Opacity'
    ]) {
      expect(screen.getByRole('slider', { name })).toHaveProperty('disabled', true)
    }
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.getAttribute('aria-disabled')).toBe('true')
    }
    expect(screen.getByRole('button', { name: /Choose Image/ })).toHaveProperty('disabled', true)

    await act(async () => {
      finishCommit()
    })
    expect(screen.getByRole('slider', { name: 'Image Blur' })).toHaveProperty('disabled', false)
  })

  it('shields the preview from an applied background on the settings page itself', () => {
    const { renderSection } = setup()
    renderSection()
    const preview = screen.getByTestId('app-background-preview')
    expect(preview.style.getPropertyValue('--app-panel-alpha')).toBe('100%')
  })
})
