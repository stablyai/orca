import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import type { SourceControlActionRecipe } from '../../../shared/source-control-ai-actions'
import { sourceControlActionLaunchOptions } from '../../../shared/source-control-action-launch-preferences'

const mockCreateTab = vi.fn()
function queuedStartups() {
  return mockCreateTab.mock.calls.flatMap((call) => call[3]?.pendingStartup ?? [])
}
const mockSetActiveTabType = vi.fn()
const mockSeedNativeChatAppliedSessionOptions = vi.fn()

type PlacementSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat?: boolean
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string>> }
  >
}

function placementSettings(overrides: Partial<PlacementSettings> = {}): PlacementSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    ...overrides
  }
}

const store = {
  settings: placementSettings(),
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: mockCreateTab,
  queueTabInitialCwd: vi.fn(),
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mockSeedNativeChatAppliedSessionOptions
}))

vi.mock('@/lib/launch-agent-in-new-tab-structured-route', () => ({
  launchStructuredAgentFromNewTab: () => ({
    surface: { kind: 'host-published' },
    pasteDraftAfterLaunch: false
  })
}))

describe('launchAgentInNewTab terminal tab activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests([])
    store.settings = placementSettings()
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  it('ignores hidden malformed arguments for chat and rejects them before any terminal creation', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const args = { agent: 'codex' as const, worktreeId: 'wt-1', agentArgs: '--model "unfinished' }
    const result = launchAgentInNewTab({
      ...args,
      agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: 'chat',
        agent: 'codex',
        worktreeId: 'wt-1'
      })
    })
    expect(result?.surface.kind).toBe('host-published')
    expect(result?.startupPlan).toBeUndefined()
    expect(launchAgentInNewTab({ ...args, requestId: 'terminal' })).toBeNull()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('applies a saved action choice as terminal flags by scope', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const base = getDefaultSettings('/tmp')
    const settings = {
      ...base,
      sourceControlAi: {
        ...base.sourceControlAi!,
        actions: {
          fixChecks: {
            agentId: 'codex' as const,
            agentArgs: '--model old --dangerously-bypass-approvals-and-sandbox',
            launchPreferences: {
              agentId: 'codex' as const,
              model: 'gpt-5.6-terra',
              options: { effort: 'high' },
              permissionMode: 'ask' as const
            }
          }
        }
      }
    }
    const launch = (fixChecks?: SourceControlActionRecipe) => {
      const recipe = resolveSourceControlActionRecipe({
        settings,
        repo: fixChecks ? { sourceControlAi: { actionOverrides: { fixChecks } } } : null,
        actionId: 'fixChecks'
      })
      const options = sourceControlActionLaunchOptions(recipe, 'codex')
      launchAgentInNewTab({
        requestId: 'request-3',
        agent: 'codex',
        worktreeId: 'wt-1',
        agentArgs: recipe.agentArgs,
        ...options
      })
      return { command: queuedStartups().at(-1)?.command, chat: options.sessionOptions }
    }

    // Loose permission text owns terminal policy; the explicit model still replaces its raw flag.
    const global = launch()
    expect(global.command).toContain("'-m' 'gpt-5.6-terra' '-c' 'model_reasoning_effort=high'")
    expect(global.command).not.toContain('old')
    expect(global.command?.match(/dangerously-bypass/g)).toHaveLength(1)
    // A repository's choice shares the same raw-permission rule.
    const repoChoice = launch({
      agentId: 'codex',
      launchPreferences: { agentId: 'codex', model: 'gpt-5.5', permissionMode: 'full-access' }
    })
    expect(repoChoice.command).toContain("'-m' 'gpt-5.5'")
    expect(repoChoice.command?.match(/dangerously-bypass/g)).toHaveLength(1)
    expect(repoChoice.command).not.toContain('old')
    // Own repository Args select the whole model/effort group on both surfaces.
    const legacy = launch({ agentArgs: '--model mine' })
    expect(legacy.command).toContain("'--model' 'mine'")
    expect(legacy.command).not.toMatch(/gpt-5\.6-terra|model_reasoning_effort/)
    expect(legacy.chat).toEqual({ permissionMode: 'ask' })
  })
})
