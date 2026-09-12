import { useCallback, useEffect, useRef, useState } from 'react'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { track } from '@/lib/telemetry'
import { buildAgentPickedPayload } from './agent-picked-payload'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveAgentPermissionModeSummary } from '../../../../shared/tui-agent-permissions'
import { resolveOnboardingSettingsHydration } from './onboarding-settings-hydration'

/**
 * Draft copies of the GlobalSettings fields the wizard edits before commit, plus the guards that
 * keep async settings hydration from overwriting a value the user already chose.
 */
export function useOnboardingSettingsDraft() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore((s) => s.isDetectingAgents || s.isRefreshingAgents)
  const pathSource = useAppStore((s) => s.pathSource)
  const pathFailureReason = useAppStore((s) => s.pathFailureReason)

  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  )
  const [yoloPermissions, setYoloPermissions] = useState(
    resolveAgentPermissionModeSummary({
      agentDefaultArgs: settings?.agentDefaultArgs,
      agentDefaultEnv: settings?.agentDefaultEnv
    }) !== 'manual'
  )
  const [agentStatusHooksEnabled, setAgentStatusHooksEnabled] = useState(
    settings?.agentStatusHooksEnabled !== false
  )
  // Why: hydrate theme from saved settings so users who already chose one see it preselected.
  const [theme, setTheme] = useState<GlobalSettings['theme']>(settings?.theme ?? 'dark')

  // Why: settings hydrate async after the lazy initializers run; re-sync once before commit unless the user edited the field.
  const themeInteractedRef = useRef(false)
  const agentInteractedRef = useRef(false)
  const yoloPermissionsInteractedRef = useRef(false)
  const agentStatusHooksInteractedRef = useRef(false)
  const [settingsHydrated, setSettingsHydrated] = useState(settings != null)
  const settingsHydration = resolveOnboardingSettingsHydration({
    settings,
    settingsHydrated,
    themeInteracted: themeInteractedRef.current,
    agentInteracted: agentInteractedRef.current,
    currentTheme: theme,
    currentAgent: selectedAgent
  })
  if (settingsHydration) {
    setSettingsHydrated(settingsHydration.settingsHydrated)
    if (settingsHydration.theme !== undefined) {
      setTheme(settingsHydration.theme)
    }
    if (settingsHydration.selectedAgent !== undefined) {
      setSelectedAgent(settingsHydration.selectedAgent)
    }
  }
  if (settings && !yoloPermissionsInteractedRef.current) {
    const nextYoloPermissions =
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: settings.agentDefaultArgs,
        agentDefaultEnv: settings.agentDefaultEnv
      }) !== 'manual'
    if (nextYoloPermissions !== yoloPermissions) {
      setYoloPermissions(nextYoloPermissions)
    }
  }
  if (settings && !agentStatusHooksInteractedRef.current) {
    const nextAgentStatusHooksEnabled = settings.agentStatusHooksEnabled !== false
    if (nextAgentStatusHooksEnabled !== agentStatusHooksEnabled) {
      setAgentStatusHooksEnabled(nextAgentStatusHooksEnabled)
    }
  }

  // Why: track interaction so async settings hydration doesn't overwrite a value the user chose.
  const setThemeInteractive = useCallback((value: GlobalSettings['theme']) => {
    themeInteractedRef.current = true
    setTheme(value)
  }, [])
  // `fromCollapsedSection`: whether the picked agent lived under AgentStep's `<details>` disclosure — only that call site knows.
  // Why the values and not mirror refs: this reads the current hydration classification at click
  // time, and depending on them directly keeps render pure. The identity churn is free — every
  // dep here is already a prop of the step that renders this handler.
  const setSelectedAgentInteractive = useCallback(
    (value: TuiAgent | null, fromCollapsedSection = false) => {
      agentInteractedRef.current = true
      // Why: de-dup re-clicks on the current agent so telemetry counts mind-changes, not idle reselection.
      const prev = selectedAgent
      setSelectedAgent(value)
      if (value === null || value === prev) {
        return
      }
      // Why: emit at click time (not step completion) to capture mind-changes; payload builder extracted for coverage — see agent-picked-payload.test.ts.
      track(
        'onboarding_agent_picked',
        buildAgentPickedPayload({
          agent: value,
          detectedAgentIds: detectedAgentIds ?? [],
          isDetecting: isDetectingAgents,
          fromCollapsedSection,
          pathSource,
          pathFailureReason
        })
      )
    },
    [detectedAgentIds, isDetectingAgents, pathFailureReason, pathSource, selectedAgent]
  )
  const setYoloPermissionsInteractive = useCallback((enabled: boolean) => {
    yoloPermissionsInteractedRef.current = true
    setYoloPermissions(enabled)
  }, [])
  const setAgentStatusHooksEnabledInteractive = useCallback(
    (enabled: boolean) => {
      agentStatusHooksInteractedRef.current = true
      setAgentStatusHooksEnabled(enabled)
      // Why persist on change: dismiss and skip persist nothing, so uncheck -> Esc must not lose
      // the choice. Unchecked by itself never removes anything; main authorizes the install from
      // the consent carried with the onboarding write, so this write failing cannot install.
      void updateSettings({ agentStatusHooksEnabled: enabled })
    },
    [updateSettings]
  )

  // Why: auto-pick only on first mount; otherwise re-running would clobber/race the user's own agent selection.
  const didAutoSelectRef = useRef(false)
  useEffect(() => {
    if (didAutoSelectRef.current) {
      return
    }
    didAutoSelectRef.current = true
    // Why: re-read PATH on mount; the session cache can be poisoned by callers that ran before shell PATH hydration, giving a false "no agents" state.
    void refreshDetectedAgents().then((ids) => {
      const preferred = getAgentCatalog().find((agent) => ids.includes(agent.id))?.id ?? null
      // Why a functional update: detection resolves async and the user may have picked while it
      // was in flight. Reading previous state here is what the mirror ref used to do.
      setSelectedAgent((current) => (current !== null ? current : preferred))
    })
  }, [refreshDetectedAgents])

  return {
    selectedAgent,
    setSelectedAgent: setSelectedAgentInteractive,
    yoloPermissions,
    setYoloPermissions: setYoloPermissionsInteractive,
    agentStatusHooksEnabled,
    setAgentStatusHooksEnabled: setAgentStatusHooksEnabledInteractive,
    theme,
    setTheme: setThemeInteractive,
    // Deliberately verbose: this one skips the interacted latch, so async settings hydration can
    // still overwrite it. Only the theme-revert on skip may use it.
    setThemeFromPersistedSettings: setTheme
  }
}
