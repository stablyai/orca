// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import { readLocalWebUIState } from './web-local-ui-state'
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

it('caches the checklist choice only after the host acknowledges it', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const ui = createWebUiApi()
  await ui.get()
  const updates = { setupGuideSettingsDismissed: true }

  await expect(ui.setWithAck!(updates)).rejects.toThrow('Offline')
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(false)

  runtime.call.mockResolvedValueOnce({})
  await ui.setWithAck!(updates)
  expect((await createWebUiApi().get()).setupGuideSettingsDismissed).toBe(true)
})

it('does not overwrite the new host checklist preference when a previous host acknowledges', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const previousHost = createWebUiApi()
  await previousHost.get()
  const acknowledge = deferNextAcknowledgement()
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

it('caches a successful save when a newer host read fails and Settings reopens offline', async () => {
  runtime.call.mockResolvedValueOnce({
    ui: { ...getDefaultUIState(), setupGuideSettingsDismissed: false }
  })
  const ui = createWebUiApi()
  await ui.get()

  const acknowledgeSave = deferNextAcknowledgement()
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
