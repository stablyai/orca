// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { CliSection } from './CliSection'

const REVEAL_KEYS = new Set([
  'auto.components.settings.CliSection.6f894ef9c2',
  'auto.components.settings.CliSection.cbe55e4d48',
  'auto.components.settings.CliSection.9fd4023db0'
])

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ canUseLocalSkillFreshness: true })
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: () => <div data-testid="agent-skill-setup-panel" />
}))

vi.mock('./CliRegistrationDialog', () => ({
  CliRegistrationDialog: () => null
}))

vi.mock('./WslCliRegistration', () => ({ WslCliRegistration: () => null }))

// Why: only the reveal keys are intercepted so the test proves they route
// through translate without disturbing the rest of the section's copy.
vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return {
    ...actual,
    translate: (...args: Parameters<typeof actual.translate>) => {
      const [key, fallback] = args
      return REVEAL_KEYS.has(key) ? `T:${fallback}` : actual.translate(...args)
    }
  }
})

function installedStatus(commandPath: string): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath,
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: commandPath,
    unsupportedReason: null,
    detail: ''
  }
}

function stubCliApi(status: CliInstallStatus): void {
  Object.assign(window, {
    api: {
      cli: {
        getInstallStatus: vi.fn().mockResolvedValue(status),
        getWslInstallStatus: vi.fn().mockResolvedValue(status),
        install: vi.fn(),
        remove: vi.fn()
      },
      shell: { openPath: vi.fn() }
    }
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CliSection reveal label localization', () => {
  it.each([
    ['darwin', 'T:Show in Finder'],
    ['win32', 'T:Show in Explorer'],
    ['linux', 'T:Show in File Manager']
  ])('localizes the reveal button on %s', async (platform, expected) => {
    stubCliApi(installedStatus('/usr/local/bin/orca'))
    render(<CliSection currentPlatform={platform} settings={getDefaultSettings('/tmp')} />)
    expect(await screen.findByText(expected)).toBeDefined()
  })
})
