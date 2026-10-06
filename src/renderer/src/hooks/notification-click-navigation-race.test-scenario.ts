import { expect, vi, type Mock } from 'vitest'

type NotificationIntent = {
  repoId?: string
  worktreeId: string
  notificationPaneKey?: string | null
  executionHostId?: string
}

export async function assertSerializedNotificationClickRace({
  listener,
  runtimeIntent,
  activateNotificationRuntimeTarget,
  activateTabAndFocusPane,
  addNewestTab
}: {
  listener: (intent: NotificationIntent) => void
  runtimeIntent: NotificationIntent
  activateNotificationRuntimeTarget: Mock
  activateTabAndFocusPane: Mock
  addNewestTab: () => void
}): Promise<void> {
  vi.clearAllMocks()
  listener(runtimeIntent)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(activateNotificationRuntimeTarget).toHaveBeenCalledWith({
    executionHostId: 'runtime:env-1',
    worktreeId: 'wt-existing',
    tabId: 'tab-native',
    leafId: '123e4567-e89b-42d3-a456-426614174000'
  })

  vi.clearAllMocks()
  activateNotificationRuntimeTarget.mockResolvedValueOnce(false)
  listener(runtimeIntent)
  await vi.waitFor(() => expect(activateNotificationRuntimeTarget).toHaveBeenCalledTimes(1))
  expect(activateTabAndFocusPane).not.toHaveBeenCalled()

  // A host selection cannot be cancelled after sending; serialize it before the newest click.
  const pendingHost = Promise.withResolvers<boolean>()
  activateNotificationRuntimeTarget.mockReset().mockResolvedValue(true)
  activateNotificationRuntimeTarget.mockReturnValueOnce(pendingHost.promise)
  activateTabAndFocusPane.mockClear()
  listener(runtimeIntent)
  await vi.waitFor(() => expect(activateNotificationRuntimeTarget).toHaveBeenCalledTimes(1))
  addNewestTab()
  listener({ ...runtimeIntent, notificationPaneKey: null })
  listener({
    ...runtimeIntent,
    worktreeId: 'wt-newest',
    notificationPaneKey: 'tab-newest:123e4567-e89b-42d3-a456-426614174000'
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(activateNotificationRuntimeTarget).toHaveBeenCalledTimes(1)
  pendingHost.resolve(true)
  await vi.waitFor(() => expect(activateNotificationRuntimeTarget).toHaveBeenCalledTimes(2))
  expect(activateNotificationRuntimeTarget).toHaveBeenLastCalledWith({
    executionHostId: 'runtime:env-1',
    worktreeId: 'wt-newest',
    tabId: 'tab-newest',
    leafId: '123e4567-e89b-42d3-a456-426614174000'
  })
  expect(activateTabAndFocusPane).toHaveBeenCalledExactlyOnceWith(
    'tab-newest',
    '123e4567-e89b-42d3-a456-426614174000',
    expect.anything()
  )
}
