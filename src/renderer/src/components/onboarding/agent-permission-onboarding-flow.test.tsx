// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import {
  applyAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS
} from '../../../../shared/tui-agent-permissions'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { useOnboardingFlow } from './use-onboarding-flow'

const onboardingUpdate = vi.fn()
const starNagOnboardingCompleted = vi.fn()
const updateSettings = vi.fn()

function installTestApi(): void {
  onboardingUpdate.mockImplementation(async (updates: Record<string, unknown>) => ({
    ...getDefaultOnboardingState(),
    ...updates
  }))
  starNagOnboardingCompleted.mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    onboarding: { update: onboardingUpdate },
    starNag: { onboardingCompleted: starNagOnboardingCompleted }
  }
}

function resetStore(settings: AppState['settings']): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings,
    repos: [],
    detectedAgentIds: [],
    isDetectingAgents: false,
    isRefreshingAgents: false,
    refreshDetectedAgents: vi.fn().mockResolvedValue([]),
    refreshPreflightStatus: vi.fn().mockResolvedValue(undefined),
    updateSettings,
    preflightStatus: null,
    preflightStatusChecked: false
  } as Partial<AppState>)
}

function autoSettings(): AppState['settings'] {
  const defaults = getDefaultSettings('/tmp')
  return {
    ...defaults,
    ...applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: defaults.agentDefaultArgs,
      agentDefaultEnv: defaults.agentDefaultEnv
    })
  }
}

function mixedSettings(): AppState['settings'] {
  const defaults = getDefaultSettings('/tmp')
  return {
    ...defaults,
    agentDefaultArgs: {
      ...defaults.agentDefaultArgs,
      codex: '--model gpt-5'
    }
  }
}

function renderFlow() {
  return renderHook(() => useOnboardingFlow(getDefaultOnboardingState(), vi.fn()))
}

describe('onboarding agent permission flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installTestApi()
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.unstubAllGlobals()
  })

  it('hydrates an Auto selection after settings arrive asynchronously', async () => {
    resetStore(null)
    const flow = renderFlow()

    expect(flow.result.current.agentPermissionMode).toBe('manual')

    await act(async () => {
      useAppStore.setState({ settings: autoSettings() })
    })

    expect(flow.result.current.agentPermissionMode).toBe('auto')
  })

  it('leaves an existing Auto profile unchanged when onboarding continues', async () => {
    const settings = autoSettings()
    resetStore(settings)
    const flow = renderFlow()

    await act(async () => {
      await flow.result.current.next()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      defaultTuiAgent: 'blank',
      agentDefaultArgs: settings?.agentDefaultArgs,
      agentDefaultEnv: settings?.agentDefaultEnv
    })
  })

  it('does not apply a preset when a mixed profile continues onboarding', async () => {
    const settings = mixedSettings()
    resetStore(settings)
    const flow = renderFlow()

    expect(flow.result.current.agentPermissionMode).toBeNull()

    await act(async () => {
      await flow.result.current.next()
    })

    expect(updateSettings).toHaveBeenCalledWith({ defaultTuiAgent: 'blank' })
  })

  it('applies Auto with manual fallbacks for unsupported agents after explicit selection', async () => {
    const defaults = getDefaultSettings('/tmp')
    resetStore(defaults)
    const flow = renderFlow()

    act(() => {
      flow.result.current.setAgentPermissionMode('auto')
    })
    await act(async () => {
      await flow.result.current.next()
    })

    const updates = updateSettings.mock.calls[0]?.[0] as {
      agentDefaultArgs?: typeof defaults.agentDefaultArgs
      agentDefaultEnv?: typeof defaults.agentDefaultEnv
    }
    expect(updates.agentDefaultArgs?.claude).toBe(AUTO_TUI_AGENT_ARGS.claude)
    expect(updates.agentDefaultArgs?.codex).toBe(AUTO_TUI_AGENT_ARGS.codex)
    expect(updates.agentDefaultArgs?.grok).toBe(AUTO_TUI_AGENT_ARGS.grok)
    expect(updates.agentDefaultArgs?.gemini).toBe('')
    expect(updates.agentDefaultEnv?.goose).toEqual({})
  })
})
