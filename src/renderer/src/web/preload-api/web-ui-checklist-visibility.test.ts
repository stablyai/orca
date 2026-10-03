// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { beginChecklistVisibilityWrite } from './web-checklist-visibility-revision'
import { readLocalWebUIState } from './web-preferences-store'
import { UI_STORAGE_KEY } from './web-storage'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => ({ call: vi.fn(), id: 'checklist-host' }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: runtime.id })
}))

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset().mockRejectedValue(new Error('Offline'))
  runtime.id = 'checklist-host'
})

function deferNextAcknowledgement(): () => void {
  let acknowledge!: () => void
  runtime.call.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      acknowledge = resolve
    })
  )
  return acknowledge
}

it.each([false, true])(
  'keeps the acknowledged checklist choice after failure and offline remount (dismissed: %j)',
  async (dismissed) => {
    runtime.call.mockResolvedValueOnce({
      ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: dismissed }
    })
    const ui = createWebUiApi()
    await ui.get()
    const updates = { setupGuideSettingsDismissed: !dismissed }

    await expect(ui.setWithAck!(updates)).rejects.toThrow('Offline')

    expect(runtime.call).toHaveBeenLastCalledWith('ui.set', updates, 15_000)
    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(dismissed)
    const reopened = createWebUiApi()
    expect((await reopened.get()).setupGuideSettingsDismissed).toBe(dismissed)

    runtime.call.mockResolvedValueOnce({})
    await reopened.setWithAck!(updates)

    expect(runtime.call).toHaveBeenLastCalledWith('ui.set', updates, 15_000)
    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(!dismissed)
    expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(!dismissed)
  }
)

it('does not overwrite the new host checklist preference when a previous host acknowledges', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const previousHost = createWebUiApi()
  await previousHost.get()
  let acknowledge!: () => void
  runtime.call.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      acknowledge = resolve
    })
  )
  const saving = previousHost.setWithAck!({ setupGuideSettingsDismissed: true })

  runtime.id = 'another-host'
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false, sidebarWidth: 420 }
  })
  const currentHost = createWebUiApi()
  await currentHost.get()

  acknowledge()
  await saving

  expect(readLocalWebUIState()).toMatchObject({
    setupGuideSettingsDismissed: false,
    sidebarWidth: 420
  })
  expect(await createWebUiApi().get()).toMatchObject({
    setupGuideSettingsDismissed: false,
    sidebarWidth: 420
  })
})

it.each([false, true])(
  'publishes the checklist choice only after acknowledgement without losing concurrent preferences (dismissed: %j)',
  async (dismissed) => {
    runtime.call.mockResolvedValueOnce({
      ui: {
        ...getDefaultUIState(),
        setupGuideSettingsDismissed: dismissed,
        sidebarWidth: 280
      }
    })
    const ui = createWebUiApi()
    await ui.get()
    let acknowledge!: () => void
    runtime.call.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acknowledge = resolve
      })
    )

    const saving = ui.setWithAck!({ setupGuideSettingsDismissed: !dismissed })

    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(dismissed)
    expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(dismissed)
    await ui.set({ sidebarWidth: 360 })
    expect(readLocalWebUIState()).toMatchObject({
      setupGuideSettingsDismissed: dismissed,
      sidebarWidth: 360
    })

    acknowledge()
    await saving

    expect(readLocalWebUIState()).toMatchObject({
      setupGuideSettingsDismissed: !dismissed,
      sidebarWidth: 360
    })
    expect(await createWebUiApi().get()).toMatchObject({
      setupGuideSettingsDismissed: !dismissed,
      sidebarWidth: 360
    })
  }
)

it.each([false, true])(
  'preserves a newer same-value host refresh from another API instance (dismissed: %j)',
  async (dismissed) => {
    const hostState = { ...getDefaultUIState(), setupGuideSettingsDismissed: dismissed }
    runtime.call.mockResolvedValueOnce({ ui: hostState })
    const writingClient = createWebUiApi()
    await writingClient.get()
    const acknowledge = deferNextAcknowledgement()
    const saving = writingClient.setWithAck!({ setupGuideSettingsDismissed: !dismissed })

    runtime.call.mockResolvedValueOnce({ ui: hostState })
    expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(dismissed)
    acknowledge()
    await saving

    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(dismissed)
    expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(dismissed)
  }
)

it('preserves the newer successful choice when two API instances acknowledge out of order', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const firstClient = createWebUiApi()
  await firstClient.get()
  const acknowledgeFirst = deferNextAcknowledgement()
  const firstSave = firstClient.setWithAck!({ setupGuideSettingsDismissed: true })

  const secondClient = createWebUiApi()
  runtime.call.mockResolvedValueOnce({})
  await secondClient.setWithAck!({ setupGuideSettingsDismissed: false })
  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(false)

  acknowledgeFirst()
  await firstSave

  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(false)
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(false)
})

it('assigns distinct write revisions when two tabs read the same prior revision', () => {
  const key = 'orca.web.checklistVisibilityRevision.v1'
  const originalGetItem = localStorage.getItem.bind(localStorage)
  let nested = false
  const attempts: NonNullable<ReturnType<typeof beginChecklistVisibilityWrite>>[] = []
  const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation((requestedKey) => {
    const snapshot = originalGetItem(requestedKey)
    if (requestedKey === key && !nested) {
      nested = true
      const secondAttempt = beginChecklistVisibilityWrite(false)
      if (secondAttempt) {
        attempts.push(secondAttempt)
      }
      return snapshot
    }
    return snapshot
  })

  try {
    const firstAttempt = beginChecklistVisibilityWrite(true)
    expect(firstAttempt).not.toBeNull()
    expect(attempts).toHaveLength(1)
    expect(firstAttempt?.observation).toBe(attempts[0].observation)
    expect(firstAttempt?.write).not.toBe(attempts[0].write)
  } finally {
    getItem.mockRestore()
  }
})

it('does not let a host read dispatched before a save overwrite the saved choice', async () => {
  let resolveRead!: (value: { ui: ReturnType<typeof getDefaultUIState> }) => void
  runtime.call.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRead = resolve
    })
  )
  const ui = createWebUiApi()
  const reading = ui.get()

  runtime.call.mockResolvedValueOnce({})
  await ui.setWithAck!({ setupGuideSettingsDismissed: true })

  resolveRead({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  expect((await reading).setupGuideSettingsDismissed).toBe(true)
  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(true)
})

it('keeps an acknowledged choice when a newer host read fails', async () => {
  let rejectRead!: (error: Error) => void
  runtime.call.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectRead = reject
    })
  )
  const ui = createWebUiApi()
  const reading = ui.get()

  runtime.call.mockResolvedValueOnce({})
  await ui.setWithAck!({ setupGuideSettingsDismissed: true })

  rejectRead(new Error('Offline'))
  expect((await reading).setupGuideSettingsDismissed).toBe(true)
  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(true)
})

it('caches a successful save when a newer host read fails and Settings reopens offline', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const ui = createWebUiApi()
  await ui.get()

  let acknowledgeSave!: () => void
  runtime.call.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      acknowledgeSave = resolve
    })
  )
  const saving = ui.setWithAck!({ setupGuideSettingsDismissed: true })

  let rejectRead!: (error: Error) => void
  runtime.call.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectRead = reject
    })
  )
  const reading = createWebUiApi().get()

  acknowledgeSave()
  await saving
  rejectRead(new Error('Offline'))

  expect((await reading).setupGuideSettingsDismissed).toBe(true)
  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(true)
  expect(await createWebUiApi().get()).toMatchObject({ setupGuideSettingsDismissed: true })
})

it('preserves checklist state refreshed by a feature interaction before an older acknowledgement', async () => {
  const hostState = { ...getDefaultUIState(), setupGuideSettingsDismissed: true }
  runtime.call.mockResolvedValueOnce({ ui: hostState })
  const ui = createWebUiApi()
  await ui.get()
  const acknowledge = deferNextAcknowledgement()
  const saving = ui.setWithAck!({ setupGuideSettingsDismissed: false })

  runtime.call.mockResolvedValueOnce({ ui: hostState })
  const refreshed = await createWebUiApi().recordFeatureInteraction('tasks')
  expect(refreshed.setupGuideSettingsDismissed).toBe(true)

  acknowledge()
  await saving

  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(true)
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(true)
})

it('preserves a newer plain-set checklist choice before an older acknowledgement', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const ui = createWebUiApi()
  await ui.get()
  const acknowledge = deferNextAcknowledgement()
  const saving = ui.setWithAck!({ setupGuideSettingsDismissed: true })

  runtime.call.mockResolvedValueOnce({})
  await createWebUiApi().set({ setupGuideSettingsDismissed: false })
  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(false)

  acknowledge()
  await saving

  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(false)
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(false)
})

it.each([
  { dismissed: false, newerFailsFirst: true },
  { dismissed: true, newerFailsFirst: true },
  { dismissed: false, newerFailsFirst: false },
  { dismissed: true, newerFailsFirst: false }
])(
  'caches an accepted save when the newer save fails (dismissed: $dismissed, failure first: $newerFailsFirst)',
  async ({ dismissed, newerFailsFirst }) => {
    runtime.call.mockResolvedValueOnce({
      ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: dismissed }
    })
    const firstClient = createWebUiApi()
    await firstClient.get()
    const acknowledgeFirst = deferNextAcknowledgement()
    const firstSave = firstClient.setWithAck!({ setupGuideSettingsDismissed: !dismissed })
    let rejectSecond!: (error: Error) => void
    runtime.call.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectSecond = reject
      })
    )
    const secondSave = createWebUiApi().setWithAck!({ setupGuideSettingsDismissed: dismissed })
    const failure = expect(secondSave).rejects.toThrow('Newer save failed')

    if (newerFailsFirst) {
      rejectSecond(new Error('Newer save failed'))
      await failure
    }
    acknowledgeFirst()
    await firstSave
    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(!dismissed)
    if (!newerFailsFirst) {
      rejectSecond(new Error('Newer save failed'))
      await failure
    }

    expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(!dismissed)
    expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(!dismissed)
  }
)

it('restores an acknowledged checklist preference after its UI cache write fails', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const ui = createWebUiApi()
  await ui.get()
  const acknowledge = deferNextAcknowledgement()
  const saving = ui.setWithAck!({ setupGuideSettingsDismissed: true })
  const originalSetItem = localStorage.setItem.bind(localStorage)
  const cacheWrite = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === UI_STORAGE_KEY) {
      throw new Error('Storage quota exceeded')
    }
    originalSetItem(key, value)
  })
  try {
    acknowledge()
    await expect(saving).resolves.toBeUndefined()
    expect(cacheWrite).toHaveBeenCalledWith(UI_STORAGE_KEY, expect.any(String))
  } finally {
    cacheWrite.mockRestore()
  }

  expect(readLocalWebUIState().setupGuideSettingsDismissed).toBe(true)
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(true)
})
