import { tmpdir } from 'node:os'
import { create } from 'zustand'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppBackgroundApi } from '../../../../preload/api/app-background-api'
import {
  createAppBackgroundDraftActions,
  resolveAppBackgroundDraftImage,
  selectAppBackgroundDraftHasUnappliedChanges,
  type AppBackgroundDraftHost
} from './app-background-draft'

const SAVED_ID = '11111111-1111-4111-8111-111111111111.png'
const STAGED_A = '22222222-2222-4222-8222-222222222222.jpg'
const STAGED_B = '33333333-3333-4333-8333-333333333333.webp'

function makeApi(overrides: Partial<AppBackgroundApi> = {}): AppBackgroundApi {
  return {
    pick: vi.fn(async () => ({ status: 'canceled' as const })),
    read: vi.fn(async () => null),
    commit: vi.fn(async ({ stagingId }) => ({ ok: true as const, imageId: stagingId })),
    discard: vi.fn(async () => {}),
    ...overrides
  }
}

function makeStore(settingsOverrides: Partial<GlobalSettings> = {}, api = makeApi()) {
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
  return { store, api, updateSettingsOrThrow }
}

const hasChanges = (state: AppBackgroundDraftHost): boolean =>
  selectAppBackgroundDraftHasUnappliedChanges(state)

describe('app background draft slice', () => {
  it('opens a draft from current settings with a snapshot and no changes', () => {
    const { store } = makeStore({
      appBackgroundImageId: SAVED_ID,
      appBackgroundScope: 'workspace',
      appBackgroundPanelOpacity: 0.5,
      terminalBackgroundOpacity: 0.7
    })

    store.getState().openAppBackgroundDraft()

    const draft = store.getState().appBackgroundDraft
    expect(draft).toMatchObject({
      scope: 'workspace',
      imageOpacity: 1,
      blur: 4,
      panelOpacity: 0.5,
      terminalBackgroundOpacity: 0.7,
      image: { kind: 'unchanged' },
      snapshot: { scope: 'workspace', panelOpacity: 0.5, imageId: SAVED_ID }
    })
    expect(hasChanges(store.getState())).toBe(false)
    expect(resolveAppBackgroundDraftImage(draft!)).toEqual({ id: SAVED_ID, staging: false })
  })

  it('reports no unapplied changes without a draft', () => {
    expect(hasChanges(makeStore().store.getState())).toBe(false)
  })

  it('keeps the original snapshot when reopened after settings changed elsewhere', () => {
    const { store } = makeStore({ appBackgroundBlur: 4 })
    store.getState().setAppBackgroundDraft({ blur: 8 })

    store.setState((state) => ({ settings: { ...state.settings!, appBackgroundBlur: 12 } }))
    store.getState().openAppBackgroundDraft()

    expect(store.getState().appBackgroundDraft).toMatchObject({ blur: 8, snapshot: { blur: 4 } })
  })

  it('rebases untouched fields and the snapshot onto settings changed elsewhere', async () => {
    const { store, updateSettingsOrThrow } = makeStore({ appBackgroundBlur: 4 })
    store.getState().setAppBackgroundDraft({ blur: 8 })
    store.setState((state) => ({
      settings: {
        ...state.settings!,
        appBackgroundBlur: 12,
        appBackgroundPanelOpacity: 0.5,
        terminalBackgroundOpacity: 0.3
      }
    }))

    store.getState().syncAppBackgroundDraftWithSettings()

    expect(store.getState().appBackgroundDraft).toMatchObject({
      blur: 8,
      panelOpacity: 0.5,
      terminalBackgroundOpacity: 0.3,
      snapshot: { blur: 12, panelOpacity: 0.5, terminalBackgroundOpacity: 0.3 }
    })
    expect(hasChanges(store.getState())).toBe(true)

    // Moving back to what settings now hold is no change; the old baseline is a real change.
    store.getState().setAppBackgroundDraft({ blur: 12 })
    expect(hasChanges(store.getState())).toBe(false)
    store.getState().setAppBackgroundDraft({ blur: 4 })
    await store.getState().applyAppBackgroundDraft()
    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({ appBackgroundBlur: 4 })
  })

  it('previews the image applied elsewhere when the draft keeps the image unchanged', () => {
    const { store } = makeStore({ appBackgroundImageId: SAVED_ID })
    store.getState().setAppBackgroundDraft({ blur: 8 })
    store.setState((state) => ({
      settings: { ...state.settings!, appBackgroundImageId: STAGED_A }
    }))

    store.getState().syncAppBackgroundDraftWithSettings()

    expect(resolveAppBackgroundDraftImage(store.getState().appBackgroundDraft!)).toEqual({
      id: STAGED_A,
      staging: false
    })
  })

  it('drops a pending removal once the image is already gone', () => {
    const { store } = makeStore({ appBackgroundImageId: SAVED_ID })
    store.getState().removeAppBackgroundDraftImage()
    store.setState((state) => ({ settings: { ...state.settings!, appBackgroundImageId: null } }))

    store.getState().syncAppBackgroundDraftWithSettings()

    expect(store.getState().appBackgroundDraft?.image).toEqual({ kind: 'unchanged' })
    expect(hasChanges(store.getState())).toBe(false)
  })

  it('leaves the draft object untouched when settings still match the snapshot', () => {
    const { store } = makeStore()
    store.getState().syncAppBackgroundDraftWithSettings()
    expect(store.getState().appBackgroundDraft).toBeNull()

    store.getState().setAppBackgroundDraft({ blur: 9 })
    const before = store.getState().appBackgroundDraft
    store.getState().syncAppBackgroundDraftWithSettings()
    expect(store.getState().appBackgroundDraft).toBe(before)
  })

  it('ignores edits while Apply is in flight so the final clear cannot drop them', async () => {
    let finishCommit: () => void = () => {}
    const api = makeApi({
      commit: vi.fn(
        () =>
          new Promise<{ ok: true; imageId: string }>((resolve) => {
            finishCommit = () => resolve({ ok: true, imageId: STAGED_A })
          })
      )
    })
    const { store } = makeStore({}, api)
    store.getState().stageAppBackgroundDraftImage(STAGED_A)
    const applying = store.getState().applyAppBackgroundDraft()

    store.getState().setAppBackgroundDraft({ blur: 15 })
    store.getState().stageAppBackgroundDraftImage(STAGED_B)
    store.getState().removeAppBackgroundDraftImage()
    store.getState().discardAppBackgroundDraft()

    expect(store.getState().appBackgroundDraft).toMatchObject({
      blur: 4,
      image: { kind: 'staged', stagingId: STAGED_A }
    })
    expect(api.discard).not.toHaveBeenCalled()
    finishCommit()
    await expect(applying).resolves.toEqual({ ok: true })
  })

  it('normalizes edits and treats reverting to the snapshot as no change', () => {
    const { store } = makeStore()

    store.getState().setAppBackgroundDraft({ panelOpacity: 0.05, blur: 99 })
    expect(store.getState().appBackgroundDraft).toMatchObject({ panelOpacity: 0.2, blur: 20 })
    expect(hasChanges(store.getState())).toBe(true)

    store.getState().setAppBackgroundDraft({ panelOpacity: 0.8, blur: 4 })
    expect(hasChanges(store.getState())).toBe(false)
  })

  it('discards the previous staged file when a new image is staged', () => {
    const { store, api } = makeStore()

    store.getState().stageAppBackgroundDraftImage(STAGED_A)
    store.getState().stageAppBackgroundDraftImage(STAGED_B)

    expect(api.discard).toHaveBeenCalledTimes(1)
    expect(api.discard).toHaveBeenCalledWith(STAGED_A)
    expect(resolveAppBackgroundDraftImage(store.getState().appBackgroundDraft!)).toEqual({
      id: STAGED_B,
      staging: true
    })
    expect(hasChanges(store.getState())).toBe(true)
  })

  it('remove drops a staged pick and only marks removal when an image is saved', () => {
    const noSaved = makeStore()
    noSaved.store.getState().stageAppBackgroundDraftImage(STAGED_A)
    noSaved.store.getState().removeAppBackgroundDraftImage()
    expect(noSaved.api.discard).toHaveBeenCalledWith(STAGED_A)
    expect(noSaved.store.getState().appBackgroundDraft?.image).toEqual({ kind: 'unchanged' })
    expect(hasChanges(noSaved.store.getState())).toBe(false)

    const saved = makeStore({ appBackgroundImageId: SAVED_ID })
    saved.store.getState().removeAppBackgroundDraftImage()
    expect(saved.store.getState().appBackgroundDraft?.image).toEqual({ kind: 'remove' })
    expect(resolveAppBackgroundDraftImage(saved.store.getState().appBackgroundDraft!)).toBeNull()
    expect(hasChanges(saved.store.getState())).toBe(true)
  })

  it('apply commits the staged image first, then writes only changed fields once', async () => {
    const order: string[] = []
    const api = makeApi({
      commit: vi.fn(async ({ stagingId }) => {
        order.push('commit')
        return { ok: true as const, imageId: stagingId }
      })
    })
    const { store, updateSettingsOrThrow } = makeStore({ terminalBackgroundOpacity: 0.9 }, api)
    updateSettingsOrThrow.mockImplementation(async () => {
      order.push('updateSettings')
    })
    store.getState().stageAppBackgroundDraftImage(STAGED_A)
    store.getState().setAppBackgroundDraft({ scope: 'workspace', terminalBackgroundOpacity: 0.5 })

    await expect(store.getState().applyAppBackgroundDraft()).resolves.toEqual({ ok: true })

    expect(order).toEqual(['commit', 'updateSettings'])
    expect(api.commit).toHaveBeenCalledWith({ stagingId: STAGED_A })
    expect(updateSettingsOrThrow).toHaveBeenCalledTimes(1)
    expect(updateSettingsOrThrow).toHaveBeenCalledWith({
      appBackgroundScope: 'workspace',
      terminalBackgroundOpacity: 0.5
    })
    expect(store.getState().settings?.appBackgroundImageId).toBe(STAGED_A)
    expect(store.getState().appBackgroundDraft).toBeNull()
    expect(store.getState().appBackgroundDraftApplying).toBe(false)
  })

  it('apply with removal commits null and skips updateSettings when nothing else changed', async () => {
    const { store, api, updateSettingsOrThrow } = makeStore({ appBackgroundImageId: SAVED_ID })
    store.getState().removeAppBackgroundDraftImage()

    await store.getState().applyAppBackgroundDraft()

    expect(api.commit).toHaveBeenCalledWith({ stagingId: null })
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(store.getState().settings?.appBackgroundImageId).toBeNull()
  })

  it('apply without an image change never calls commit', async () => {
    const { store, api, updateSettingsOrThrow } = makeStore()
    store.getState().setAppBackgroundDraft({ imageOpacity: 0.3 })

    await store.getState().applyAppBackgroundDraft()

    expect(api.commit).not.toHaveBeenCalled()
    expect(updateSettingsOrThrow).toHaveBeenCalledWith({ appBackgroundImageOpacity: 0.3 })
  })

  it('keeps the draft when commit fails', async () => {
    const api = makeApi({
      commit: vi.fn(async () => ({ ok: false as const, reason: 'stagingMissing' as const }))
    })
    const { store, updateSettingsOrThrow } = makeStore({}, api)
    store.getState().stageAppBackgroundDraftImage(STAGED_A)

    await expect(store.getState().applyAppBackgroundDraft()).resolves.toEqual({
      ok: false,
      reason: 'stagingMissing'
    })
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(store.getState().appBackgroundDraft?.image).toEqual({
      kind: 'staged',
      stagingId: STAGED_A
    })
  })

  it('rebases the draft onto the committed image when the settings write fails', async () => {
    const { store, api, updateSettingsOrThrow } = makeStore()
    updateSettingsOrThrow.mockRejectedValueOnce(new Error('disk full'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.getState().stageAppBackgroundDraftImage(STAGED_A)
    store.getState().setAppBackgroundDraft({ blur: 5 })

    await expect(store.getState().applyAppBackgroundDraft()).resolves.toEqual({
      ok: false,
      reason: 'saveFailed'
    })
    expect(store.getState().appBackgroundDraft).toMatchObject({
      blur: 5,
      image: { kind: 'unchanged' },
      snapshot: { imageId: STAGED_A }
    })

    await store.getState().applyAppBackgroundDraft()
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(store.getState().appBackgroundDraft).toBeNull()
  })

  it('discard drops the staged file and clears the draft without touching settings', () => {
    const { store, api, updateSettingsOrThrow } = makeStore()
    store.getState().stageAppBackgroundDraftImage(STAGED_A)
    store.getState().setAppBackgroundDraft({ panelOpacity: 0.4 })

    store.getState().discardAppBackgroundDraft()

    expect(api.discard).toHaveBeenCalledWith(STAGED_A)
    expect(store.getState().appBackgroundDraft).toBeNull()
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(hasChanges(store.getState())).toBe(false)
  })

  it('rejects apply without a draft', async () => {
    await expect(makeStore().store.getState().applyAppBackgroundDraft()).resolves.toEqual({
      ok: false,
      reason: 'noDraft'
    })
  })
})
