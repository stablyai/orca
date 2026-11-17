import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { useAppStore } from '@/store'
import { setAgentDefaultSurfaceFromFeatureTip } from './chat-ui-here-actions'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))

function seedSettings(overrides: Partial<GlobalSettings>): void {
  const updateSettingsOrThrow = (updates: Partial<GlobalSettings>): Promise<void> => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({ settings: settings && { ...settings, ...updates } })
    return Promise.resolve()
  }
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), ...overrides },
    updateSettingsOrThrow
  })
}

describe('setAgentDefaultSurfaceFromFeatureTip', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear()
  })

  it.each([
    { from: 'terminal', to: 'chat', claudeChat: false },
    { from: 'chat', to: 'terminal', claudeChat: true }
  ] as const)(
    'names agents kept on their own surface when switching to $to',
    async ({ from, to, claudeChat }) => {
      seedSettings({ agentDefaultSurface: from, nativeChatProviders: { claude: claudeChat } })

      await expect(setAgentDefaultSurfaceFromFeatureTip(to)).resolves.toBe('reported')

      expect(toast.success).toHaveBeenCalledTimes(1)
      const options = vi.mocked(toast.success).mock.calls[0]?.[1]
      expect(String(options?.description)).toContain('Claude')
      expect(useAppStore.getState().settings?.agentDefaultSurface).toBe(to)
    }
  )
})
