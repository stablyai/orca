// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { NotificationsPane } from './NotificationsPane'

vi.mock('./use-notification-source-options', () => ({
  useNotificationSourceOptions: () =>
    buildExecutionHostRegistry({
      repos: [],
      settings: null,
      sshTargetLabels: new Map([
        ['a', 'Remote A'],
        ['b', 'Remote B']
      ])
    })
}))

vi.mock('@/components/notifications/mac-notification-permission-card', () => ({
  useMacNotificationPermissionState: () => [null, vi.fn()],
  MacNotificationPermissionCard: () => null
}))
vi.mock('./NotificationSoundSection', () => ({ NotificationSoundSection: () => null }))

afterEach(() => vi.unstubAllGlobals())

it('applies each machine change to the pending settings while saves are unresolved', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const writes: Partial<GlobalSettings>[] = []
  const resolveSaves: (() => void)[] = []
  const updateSettings = (update: Partial<GlobalSettings>): Promise<void> => {
    writes.push(update)
    return new Promise((resolve) => resolveSaves.push(resolve))
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <NotificationsPane
          settings={createGlobalSettingsFixture()}
          updateSettings={updateSettings}
        />
      )
    )
    const expandButton = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')
    expect(expandButton).not.toBeNull()
    await act(async () => expandButton?.click())
    for (const label of ['Remote A', 'Remote B']) {
      const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
      expect(button).not.toBeNull()
      await act(async () => button?.click())
    }
    expect(writes.map((write) => write.notifications?.mutedNotificationSourceIds)).toEqual([
      ['ssh:a'],
      ['ssh:a', 'ssh:b']
    ])
  } finally {
    await act(async () => {
      resolveSaves.forEach((resolve) => resolve())
      root.unmount()
    })
  }
})
