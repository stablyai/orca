// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../../../shared/cli-install-types'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The key shows in the text, so the test sees which strings are localized.
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string, vars?: Record<string, string | number>) =>
    `[${key}] ${fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''))}`
}))

import { useCliRegistrationActions } from './use-cli-registration-actions'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function installedStatus(detail: string): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca Beta.app/Contents/Resources/bin/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: '/Applications/Orca Beta.app/Contents/Resources/bin/orca',
    unsupportedReason: null,
    detail
  }
}

async function installWith(detail: string): Promise<void> {
  vi.stubGlobal('api', { cli: { install: vi.fn().mockResolvedValue(installedStatus(detail)) } })
  const { result } = renderHook(() =>
    useCliRegistrationActions({
      commandName: 'orca',
      mountedRef: { current: true },
      onStatusChange: vi.fn(),
      onSettled: vi.fn()
    })
  )
  await act(() => result.current.install())
}

it('shows the localized replaced-link detail as the success toast description', async () => {
  await installWith(
    'Replaced the /usr/local/bin/orca link to /Applications/Orca.app. To switch back, register the CLI again in that app.'
  )
  expect(toast.success).toHaveBeenCalledWith(
    '[auto.components.settings.CliSection.9cbcd31338] Registered `orca` in PATH.',
    {
      description:
        '[auto.lib.cli.detail.replacedOtherAppLink] Replaced the /usr/local/bin/orca link to /Applications/Orca.app. To switch back, register the CLI again in that app.'
    }
  )
})

it('shows no description for a plain registered detail', async () => {
  await installWith('Registered at /usr/local/bin/orca.')
  expect(toast.success).toHaveBeenCalledWith(
    '[auto.components.settings.CliSection.9cbcd31338] Registered `orca` in PATH.',
    undefined
  )
})
