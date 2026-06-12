/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings, OrcaHooks } from '../../../../shared/types'
import type { SpeechModelState } from '../../../../shared/speech-types'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { applyDocumentTheme } from '@/lib/document-theme'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { DEFAULT_APP_FONT_FAMILY, getDefaultVoiceSettings } from '../../../../shared/constants'
import { GeneralPane } from './GeneralPane'
import { BrowserPane } from './BrowserPane'
import { AppearancePane } from './AppearancePane'
import { InputPane } from './InputPane'
import { ShortcutsPane } from './ShortcutsPane'
import { TerminalPane } from './TerminalPane'
import { FloatingWorkspacePane } from './FloatingWorkspacePane'
import { useGhosttyImport } from './useGhosttyImport'
import { useWarpThemeImport } from './useWarpThemeImport'
import { RepositoryPane } from './RepositoryPane'
import { GitPane } from './GitPane'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { NotificationsPane } from './NotificationsPane'
import { VoicePane } from './VoicePane'
import { SshPane } from './SshPane'
import { ExperimentalPane } from './ExperimentalPane'
import { AgentsPane } from './AgentsPane'
import { OrchestrationPane } from './OrchestrationPane'
import { AccountsPane } from './AccountsPane'
import { StatsPane } from '../stats/StatsPane'
import { IntegrationsPane } from './IntegrationsPane'
import { TasksPane } from './TasksPane'
import { QuickCommandsPane } from './QuickCommandsPane'
import { DeveloperPermissionsPane } from './DeveloperPermissionsPane'
import { ComputerUsePane } from './ComputerUsePane'
import { MobileSettingsPane } from './MobileSettingsPane'
import { MobileEmulatorSettingsPane } from './MobileEmulatorSettingsPane'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'
import { PrivacyPane } from './PrivacyPane'
import { AdvancedPane } from './AdvancedPane'
import { SettingsSidebar } from './SettingsSidebar'
import { SettingsSetupGuidePane } from './SettingsSetupGuidePane'
import { ActiveSettingsSectionProvider, SettingsSection } from './SettingsSection'
import { matchesSettingsSearch } from './settings-search'
import { cn } from '@/lib/utils'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import {
  isWebClientLocation,
  useSettingsNavigationMetadata
} from '@/hooks/useSettingsNavigationMetadata'
import type {
  SettingsNavGroup,
  SettingsNavInstallStatus,
  SettingsNavSection,
  SettingsNavTarget
} from '@/lib/settings-navigation-types'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  deriveNeededRepoIds,
  deriveNeededSectionIds,
  getInitialMountedSectionIds,
  getRuntimeTargetIdentity
} from './settings-load-performance'
import { translate } from '@/i18n/i18n'

const SETTINGS_NAV_GROUPS = [
  {
    id: 'capabilities',
    title: translate('auto.components.settings.Settings.23c6874fdf', 'AI Capabilities')
  },
  { id: 'setup', title: translate('auto.components.settings.Settings.9abb9be3bc', 'Set Up') },
  {
    id: 'workflows',
    title: translate('auto.components.settings.Settings.e1578cd4bc', 'Workflows')
  },
  {
    id: 'interface',
    title: translate('auto.components.settings.Settings.8bd117d669', 'Interface')
  },
  {
    id: 'remote',
    title: translate('auto.components.settings.Settings.23931df7e8', 'Remote Access')
  },
  {
    id: 'security',
    title: translate('auto.components.settings.Settings.084d8fac5b', 'Privacy & Security')
  },
  { id: 'advanced', title: translate('auto.components.settings.Settings.1c87f8d024', 'Advanced') },
  {
    id: 'experimental',
    title: translate('auto.components.settings.Settings.8b017f2506', 'Experimental')
  }
] as const

const SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID = 'shortcuts-escape-confirm'
const SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS = 2200

function getSettingsSectionId(pane: SettingsNavTarget, repoId: string | null): string {
  if (pane === 'repo' && repoId) {
    return `repo-${repoId}`
  }
  return pane
}

function getFallbackVisibleSection(sections: SettingsNavSection[]): SettingsNavSection | undefined {
  return sections.at(0)
}

function getSkillNavInstallStatus(skill: {
  installed: boolean
  loading: boolean
}): SettingsNavInstallStatus {
  if (skill.loading) {
    return 'checking'
  }
  return skill.installed ? 'installed' : 'install'
}

function hasReadyVoiceModel(
  settings: GlobalSettings,
  modelStates: readonly SpeechModelState[]
): boolean {
  const voiceSettings = settings.voice ?? getDefaultVoiceSettings()
  if (
    voiceSettings.sttModel !== '' &&
    modelStates.some((state) => state.id === voiceSettings.sttModel && state.status === 'ready')
  ) {
    return true
  }
  return modelStates.some((state) => state.status === 'ready')
}

function getSettingsScrollTarget(
  sectionId: string,
  container?: HTMLElement | null
): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(`[data-settings-section="${CSS.escape(sectionId)}"]`) ??
    document.getElementById(sectionId)
  )
}

function scrollSubsectionIntoView(targetId: string, container?: HTMLElement | null): void {
  // Why: deep links into Settings can target a specific subsection inside a
  // pane (e.g. a particular row). The pane itself is now swapped in
  // wholesale, so this only needs to nudge the inner scroll if the pane has
  // grown taller than the viewport.
  const target = getSettingsScrollTarget(targetId, container)
  if (!target) {
    return
  }
  if (!container) {
    target.scrollIntoView({ block: 'start' })
    return
  }
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const targetTop = targetRect.top - containerRect.top + container.scrollTop
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTo({ top: Math.min(Math.max(0, targetTop - 16), maxScrollTop) })
}

function readSourceControlAiSettings(settings: GlobalSettings): SourceControlAiSettings {
  return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
}

function cancelPendingSettingsSubsectionScrollFrame(
  frameRef: MutableRefObject<number | null>
): void {
  if (frameRef.current !== null) {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const keybindings = useAppStore((s) => s.keybindings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const fetchKeybindings = useAppStore((s) => s.fetchKeybindings)
  const closeSettingsPage = useAppStore((s) => s.closeSettingsPage)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeProject = useAppStore((s) => s.removeProject)
  const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget)
  const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget)
  const settingsSearchInputQuery = useAppStore((s) => s.settingsSearchInputQuery)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)

  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
  >({})
  const systemPrefersDark = useSystemPrefersDark()
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const isWebClient = isWebClientLocation()
  const showDesktopOnlySettings = !isWebClient
  const orchestrationSkill = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const computerUseSkill = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    enabled: showDesktopOnlySettings,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const [voiceModelStatesLoading, setVoiceModelStatesLoading] = useState(showDesktopOnlySettings)
  // Why: the Terminal settings section shares one search index with the
  // sidebar. We trim platform-only entries on other platforms so search never
  // reveals controls that the renderer will intentionally hide.
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevScrollbackBytes, setPrevScrollbackBytes] = useState(settings?.terminalScrollbackBytes)
  // Why: Appearance owns terminal visual controls, but the Ghostty import flow
  // still needs Settings-level state so the modal survives section remounts.
  const ghostty = useGhosttyImport(updateSettings, settings)
  const warpThemes = useWarpThemeImport(updateSettings, settings)
  const [fontSuggestions, setFontSuggestions] = useState<string[]>(
    Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...getFallbackTerminalFonts()]))
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
  const [mountedSectionIds, setMountedSectionIds] = useState<Set<string>>(
    getInitialMountedSectionIds
  )
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const [quickCommandAddIntentSignal, setQuickCommandAddIntentSignal] = useState(0)
  const [hasUnsavedCommitPromptChanges, setHasUnsavedCommitPromptChanges] = useState(false)
  const [hasUnsavedBranchPromptChanges, setHasUnsavedBranchPromptChanges] = useState(false)
  const [sourceControlAiPromptDiscardSignal, setSourceControlAiPromptDiscardSignal] = useState(0)
  const confirm = useConfirmationDialog()
  // Why: the hidden-experimental group is an unlock — Shift-clicking the
  // Experimental sidebar entry reveals it for the remainder of the session.
  // Not persisted on purpose: it's a power-user affordance we don't want to
  // leak through into a normal reopen of Settings.
  const [hiddenExperimentalUnlocked, setHiddenExperimentalUnlocked] = useState(false)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const terminalFontsLoadedRef = useRef(false)
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)
  const pendingSubsectionScrollFrameRef = useRef<number | null>(null)
  const repoHooksRequestSeqRef = useRef(0)
  const repoHooksRuntimeIdentityRef = useRef<string>('local')
  const shortcutsEscapeConfirmUntilRef = useRef(0)
  const sourceControlAiWriteQueueRef = useRef<Promise<void>>(Promise.resolve())

  const hasUnsavedSourceControlAiPromptChanges =
    hasUnsavedCommitPromptChanges || hasUnsavedBranchPromptChanges

  const writeSourceControlAiSettings = useCallback(
    (patch: SourceControlAiSettingsPatch): Promise<void> => {
      const next = sourceControlAiWriteQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const latestSettings = useAppStore.getState().settings ?? settings
          if (!latestSettings) {
            return
          }
          const latestConfig = readSourceControlAiSettings(latestSettings)
          const resolvedPatch = typeof patch === 'function' ? patch(latestConfig) : patch
          await updateSettings({ sourceControlAi: { ...latestConfig, ...resolvedPatch } })
        })
      sourceControlAiWriteQueueRef.current = next
      return next
    },
    [settings, updateSettings]
  )

  const setSettingsRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Why: the settings search is a transient in-page filter. Leaving it behind makes the next
      // visit look partially broken because whole sections stay hidden before the user types again.
      setSettingsSearchQuery('')
    },
    [setSettingsSearchQuery]
  )

  const setContentScrollNode = useCallback((node: HTMLDivElement | null): void => {
    contentScrollRef.current = node
    if (node !== null) {
      return
    }
    // Why: pending subsection jumps are scoped to the scroll container; cancel
    // them with the container so a stale deep-link frame cannot run after close.
    cancelPendingSettingsSubsectionScrollFrame(pendingSubsectionScrollFrameRef)
  }, [])

  const confirmDiscardSourceControlAiPromptChanges = useCallback(async (): Promise<boolean> => {
    if (!hasUnsavedSourceControlAiPromptChanges) {
      return true
    }
    const shouldDiscard = await confirm({
      title: translate(
        'auto.components.settings.Settings.17bdee4ff1',
        'Discard unsaved Git AI Author changes?'
      ),
      description: translate(
        'auto.components.settings.Settings.43b68e10f0',
        'You have unsaved Git AI Author changes. Leaving will discard them.'
      ),
      confirmLabel: translate('auto.components.settings.Settings.65358016ea', 'Discard'),
      confirmVariant: 'destructive'
    })
    if (shouldDiscard) {
      setSourceControlAiPromptDiscardSignal((signal) => signal + 1)
      setHasUnsavedCommitPromptChanges(false)
      setHasUnsavedBranchPromptChanges(false)
    }
    return shouldDiscard
  }, [confirm, hasUnsavedSourceControlAiPromptChanges])

  const closeSettingsPageWithPromptGuard = useCallback(async (): Promise<void> => {
    if (!(await confirmDiscardSourceControlAiPromptChanges())) {
      return
    }
    closeSettingsPage()
  }, [closeSettingsPage, confirmDiscardSourceControlAiPromptChanges])

  useEffect(() => {
    fetchSettings()
    fetchKeybindings()
  }, [fetchKeybindings, fetchSettings])

  useEffect(() => {
    if (!showDesktopOnlySettings) {
      setVoiceModelStatesLoading(false)
      return
    }
    let canceled = false
    // Why: modelStates starts empty, so Voice should not briefly look missing
    // before the first speech-model scan reports the real installed state.
    setVoiceModelStatesLoading(true)
    void refreshModelStates().finally(() => {
      if (!canceled) {
        setVoiceModelStatesLoading(false)
      }
    })
    return () => {
      canceled = true
    }
  }, [refreshModelStates, showDesktopOnlySettings])

  const runtimeTargetIdentity = getRuntimeTargetIdentity(settings)

  useEffect(() => {
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false
        }
        if (element.closest('[aria-hidden="true"]')) {
          return false
        }
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        )
      })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // Why: nested dialogs and menus own Escape before Settings page-level
      // navigation, including the unsaved Source Control AI confirmation dialog.
      if (hasVisibleOverlay()) {
        return
      }
      // Why: Escape in an editable control usually means "cancel this edit",
      // not "close Settings". Closing the entire page would discard the user's
      // in-progress typing. Defer to the field's own handler when focus is on
      // an input/textarea/select or contenteditable region; a subsequent
      // Escape (with focus back on the body) will then close the page.
      if (isEditableTarget(event.target)) {
        return
      }
      if (activeSectionId === 'shortcuts') {
        event.preventDefault()
        const now = Date.now()
        if (now <= shortcutsEscapeConfirmUntilRef.current) {
          shortcutsEscapeConfirmUntilRef.current = 0
          toast.dismiss(SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID)
          void closeSettingsPageWithPromptGuard()
          return
        }
        shortcutsEscapeConfirmUntilRef.current = now + SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS
        toast.info(
          translate(
            'auto.components.settings.Settings.acc7bbdefd',
            'Press ESC again to exit settings'
          ),
          {
            id: SHORTCUTS_ESCAPE_CONFIRM_TOAST_ID,
            duration: SHORTCUTS_ESCAPE_CONFIRM_WINDOW_MS,
            className: 'whitespace-nowrap'
          }
        )
        return
      }
      void closeSettingsPageWithPromptGuard()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeSectionId, closeSettingsPageWithPromptGuard])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (isIntentionalAppRestartInProgress()) {
        return
      }
      if (!hasUnsavedSourceControlAiPromptChanges) {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedSourceControlAiPromptChanges])

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return
      }
      if (!keybindingMatchesAction('settings.search', event, getShortcutPlatform(), keybindings)) {
        return
      }
      const input = searchInputRef.current
      if (!input) {
        return
      }
      event.preventDefault()
      input.focus()
      input.select()
    }

    document.addEventListener('keydown', handleFindShortcut)
    return () => document.removeEventListener('keydown', handleFindShortcut)
  }, [keybindings])

  useEffect(() => {
    if (!settings || !settingsNavigationTarget) {
      return
    }

    const paneSectionId = getSettingsSectionId(
      settingsNavigationTarget.pane as SettingsNavTarget,
      settingsNavigationTarget.repoId
    )
    pendingNavSectionRef.current = paneSectionId
    pendingScrollTargetRef.current = settingsNavigationTarget.sectionId ?? paneSectionId
    if (settingsNavigationTarget.intent === 'add-quick-command') {
      setQuickCommandAddIntentSignal((signal) => signal + 1)
    }
    setMountedSectionIds((previous) => {
      if (previous.has(paneSectionId)) {
        return previous
      }
      return new Set(previous).add(paneSectionId)
    })
    // Why: target consumption stores refs, so bump state to guarantee the
    // scroll effect runs even when the visible section set is otherwise stable.
    setPendingNavRequestTick((tick) => tick + 1)
    clearSettingsTarget()
  }, [clearSettingsTarget, settings, settingsNavigationTarget])

  // Why: only recompute scrollback mode when the byte value actually changes,
  // not on every unrelated settings mutation.
  if (settings?.terminalScrollbackBytes !== prevScrollbackBytes) {
    setPrevScrollbackBytes(settings?.terminalScrollbackBytes)
    if (settings) {
      const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
      setScrollbackMode(
        SCROLLBACK_PRESETS_MB.includes(scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number])
          ? 'preset'
          : 'custom'
      )
    }
  }

  const applyTheme = useCallback((theme: 'system' | 'dark' | 'light') => {
    applyDocumentTheme(theme)
  }, [])

  const displayedGitUsername = repos[0]?.gitUsername ?? ''
  const baseNavSections = useSettingsNavigationMetadata()
  const { installed: orchestrationSkillInstalled, loading: orchestrationSkillLoading } =
    orchestrationSkill
  const { installed: computerUseSkillInstalled, loading: computerUseSkillLoading } =
    computerUseSkill
  const capabilityInstallStatusBySectionId = useMemo(() => {
    const next = new Map<string, SettingsNavInstallStatus>([
      [
        'orchestration',
        getSkillNavInstallStatus({
          installed: orchestrationSkillInstalled,
          loading: orchestrationSkillLoading
        })
      ]
    ])
    if (showDesktopOnlySettings) {
      next.set(
        'computer-use',
        getSkillNavInstallStatus({
          installed: computerUseSkillInstalled,
          loading: computerUseSkillLoading
        })
      )
      if (settings) {
        next.set(
          'voice',
          voiceModelStatesLoading
            ? 'checking'
            : hasReadyVoiceModel(settings, modelStates)
              ? 'installed'
              : 'install'
        )
      }
    }
    return next
  }, [
    computerUseSkillInstalled,
    computerUseSkillLoading,
    modelStates,
    orchestrationSkillInstalled,
    orchestrationSkillLoading,
    settings,
    showDesktopOnlySettings,
    voiceModelStatesLoading
  ])
  const navSections = useMemo(
    () =>
      baseNavSections.map((section) => {
        const installStatus = capabilityInstallStatusBySectionId.get(section.id)
        return installStatus ? { ...section, installStatus } : section
      }),
    [baseNavSections, capabilityInstallStatusBySectionId]
  )
  const navSectionById = useMemo(
    () => new Map(navSections.map((section) => [section.id, section] as const)),
    [navSections]
  )
  const getSectionSearchEntries = (sectionId: string) =>
    navSectionById.get(sectionId)?.searchEntries ?? []

  const visibleNavSections = useMemo(
    () =>
      navSections.filter((section) =>
        section.id === 'git' && hasUnsavedSourceControlAiPromptChanges
          ? true
          : matchesSettingsSearch(settingsSearchQuery, [
              { title: section.title, description: section.description },
              ...section.searchEntries
            ])
      ),
    [hasUnsavedSourceControlAiPromptChanges, navSections, settingsSearchQuery]
  )
  const visibleSectionIds = useMemo(
    () => new Set(visibleNavSections.map((section) => section.id)),
    [visibleNavSections]
  )
  const neededSectionIds = useMemo(
    () =>
      deriveNeededSectionIds({
        navSectionIds: navSections.map((section) => section.id),
        mountedSectionIds,
        activeSectionId,
        pendingSectionId: pendingNavSectionRef.current,
        query: settingsSearchQuery,
        visibleSectionIds
      }),
    [activeSectionId, mountedSectionIds, navSections, settingsSearchQuery, visibleSectionIds]
  )
  const windowsTerminalCapabilityOwnerKey = getWindowsTerminalCapabilityOwnerKey(
    settings?.activeRuntimeEnvironmentId
  )
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const hasActiveRuntimeEnvironment = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const shouldLoadWindowsTerminalCapabilities =
    hasActiveRuntimeEnvironment ||
    ((isWindows || isWebClient) &&
      (neededSectionIds.has('terminal') ||
        neededSectionIds.has('general') ||
        neededSectionIds.has('accounts') ||
        neededSectionIds.has('agents')))
  // Why: General owns the Orca CLI controls, including WSL skill-location setup.
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldLoadWindowsTerminalCapabilities,
    true,
    windowsTerminalCapabilityOwnerKey,
    runtimeTarget
  )
  // Why: WSL can be unsupported on macOS/Linux, or supported-but-unavailable on Windows.
  // Only the latter should render disabled WSL controls.
  const wslSupportedPlatform = isWindows || windowsTerminalCapabilities.hostPlatform === 'win32'
  const isWindowsTerminalHost = isWindows || windowsTerminalCapabilities.hostPlatform === 'win32'

  if ([...neededSectionIds].some((id) => !mountedSectionIds.has(id))) {
    // Why: lazy Settings sections are remembered for the session; record newly
    // needed sections during render so panes do not wait for a follow-up Effect.
    setMountedSectionIds(neededSectionIds)
  }

  useEffect(() => {
    if (!neededSectionIds.has('appearance') && !neededSectionIds.has('terminal')) {
      return
    }
    if (terminalFontsLoadedRef.current) {
      return
    }

    let stale = false
    const loadFontSuggestions = async (): Promise<void> => {
      try {
        const fonts = await window.api.settings.listFonts()
        if (stale || fonts.length === 0) {
          return
        }
        terminalFontsLoadedRef.current = true
        setFontSuggestions((prev) =>
          Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...fonts, ...prev])).slice(0, 320)
        )
      } catch {
        // Fall back to curated cross-platform suggestions.
      }
    }
    void loadFontSuggestions()
    return () => {
      stale = true
    }
  }, [neededSectionIds])

  const neededRepoIds = useMemo(
    () => deriveNeededRepoIds(repos, neededSectionIds),
    [neededSectionIds, repos]
  )

  useEffect(() => {
    const repoIdSet = new Set(repos.map((repo) => repo.id))
    setRepoHooksMap((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([repoId]) => repoIdSet.has(repoId))
      ) as Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [repos])

  useEffect(() => {
    if (repoHooksRuntimeIdentityRef.current !== runtimeTargetIdentity) {
      repoHooksRuntimeIdentityRef.current = runtimeTargetIdentity
      repoHooksRequestSeqRef.current += 1
      setRepoHooksMap({})
    }
  }, [runtimeTargetIdentity])

  useEffect(() => {
    if (neededRepoIds.length === 0) {
      return
    }

    let stale = false
    const requestSeq = ++repoHooksRequestSeqRef.current
    const repoById = new Map(repos.map((repo) => [repo.id, repo] as const))

    void Promise.all(
      neededRepoIds.map(async (repoId) => {
        const repo = repoById.get(repoId)
        if (!repo) {
          return
        }
        if (isFolderRepo(repo)) {
          setRepoHooksMap((previous) => {
            if (previous[repoId]) {
              return previous
            }
            return {
              ...previous,
              [repoId]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
          return
        }
        try {
          const result = await checkRuntimeHooks(
            runtimeTargetIdentity === 'local'
              ? { activeRuntimeEnvironmentId: null }
              : { activeRuntimeEnvironmentId: runtimeTargetIdentity },
            repoId
          )
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!repos.some((entry) => entry.id === repoId)) {
              return previous
            }
            return { ...previous, [repoId]: result }
          })
        } catch {
          // Keep last known value on transient failures.
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!repos.some((entry) => entry.id === repoId)) {
              return previous
            }
            if (previous[repoId]) {
              return previous
            }
            return {
              ...previous,
              [repoId]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
        }
      })
    )

    return () => {
      stale = true
    }
  }, [neededRepoIds, repos, runtimeTargetIdentity])

  useEffect(() => {
    const scrollTargetId = pendingScrollTargetRef.current
    const pendingNavSectionId = pendingNavSectionRef.current

    if (scrollTargetId && pendingNavSectionId && settingsSearchQuery.trim() !== '') {
      setSettingsSearchQuery('')
      return
    }

    if (scrollTargetId && pendingNavSectionId && visibleSectionIds.has(pendingNavSectionId)) {
      // Why: inactive Settings panes no longer render in the empty-search view.
      // Activate the pane first, then wait for the next render before looking
      // for any subsection target inside it.
      if (activeSectionId !== pendingNavSectionId) {
        setActiveSectionId(pendingNavSectionId)
        return
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      // Why: deep links can target a row inside the pane; the pane itself is
      // already in view because the sidebar swap rendered just it.
      if (scrollTargetId !== pendingNavSectionId) {
        // Why: target navigation can arrive before the lazy section has mounted;
        // keep the pending refs alive until the mounted-section update commits.
        if (!getSettingsScrollTarget(scrollTargetId, container)) {
          return
        }
        const scrollToSubsection = (): void => {
          scrollSubsectionIntoView(scrollTargetId, contentScrollRef.current)
        }
        scrollToSubsection()
        cancelPendingSettingsSubsectionScrollFrame(pendingSubsectionScrollFrameRef)
        let completed = false
        let frameId: number | undefined
        frameId = requestAnimationFrame(() => {
          completed = true
          if (pendingSubsectionScrollFrameRef.current === frameId) {
            pendingSubsectionScrollFrameRef.current = null
          }
          scrollToSubsection()
        })
        if (!completed) {
          pendingSubsectionScrollFrameRef.current = frameId
        }
      }
      setActiveSectionId(pendingNavSectionId)
      pendingNavSectionRef.current = null
      pendingScrollTargetRef.current = null
      return
    }

    if (!visibleSectionIds.has(activeSectionId) && visibleNavSections.length > 0) {
      setActiveSectionId(getFallbackVisibleSection(visibleNavSections)?.id ?? activeSectionId)
    }
  }, [
    activeSectionId,
    pendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery,
    visibleSectionIds,
    visibleNavSections
  ])

  const scrollToSection = useCallback(
    async (
      sectionId: string,
      modifiers?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
    ): Promise<void> => {
      if (sectionId !== activeSectionId && !(await confirmDiscardSourceControlAiPromptChanges())) {
        return
      }
      // Why: Shift-clicking the Experimental sidebar entry unlocks a hidden
      // power-user group. Keep this scoped to the Experimental row so normal
      // shortcut combos on other rows don't accidentally flip state. The
      // unlock persists for the life of the Settings view (resets when
      // Settings is reopened).
      if (sectionId === 'experimental' && modifiers?.shiftKey) {
        setHiddenExperimentalUnlocked((previous) => !previous)
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      if (settingsSearchQuery.trim() !== '') {
        // Why: sidebar search is a discovery tool. Once a user selects a
        // section from the filtered results, show the actual pane instead of
        // keeping another matching pane rendered by the stale query.
        setSettingsSearchQuery('')
      }
      setActiveSectionId(sectionId)
    },
    [
      activeSectionId,
      confirmDiscardSourceControlAiPromptChanges,
      setSettingsSearchQuery,
      settingsSearchQuery
    ]
  )

  const openComputerUseFromBrowser = useCallback(async () => {
    if (!(await confirmDiscardSourceControlAiPromptChanges())) {
      return
    }
    pendingNavSectionRef.current = 'computer-use'
    pendingScrollTargetRef.current = 'computer-use'
    if (settingsSearchQuery !== '') {
      setSettingsSearchQuery('')
      return
    }
    // Why: the pending section refs do not schedule a render by themselves.
    // When search is already clear, this reruns the centralized jump effect.
    setPendingNavRequestTick((tick) => tick + 1)
  }, [confirmDiscardSourceControlAiPromptChanges, setSettingsSearchQuery, settingsSearchQuery])

  if (!settings) {
    return (
      <div
        ref={setSettingsRootNode}
        className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background"
      >
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {translate('auto.components.settings.Settings.c7ad095d96', 'Loading settings...')}
        </div>
      </div>
    )
  }

  const generalNavSections = visibleNavSections.filter((section) => !section.id.startsWith('repo-'))
  const generalNavGroups: SettingsNavGroup[] = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    sections: generalNavSections.filter((section) => section.group === group.id)
  })).filter((group) => group.sections.length > 0 || group.id === 'setup')
  const repoNavSections = visibleNavSections
    .filter((section) => section.id.startsWith('repo-'))
    .map((section) => {
      const repo = repos.find((entry) => entry.id === section.id.replace('repo-', ''))
      return {
        ...section,
        badgeColor: repo?.badgeColor,
        isRemote: !!repo?.connectionId,
        repoIcon: repo?.repoIcon,
        upstream: repo?.upstream
      }
    })
  const isSectionMounted = (sectionId: string): boolean => neededSectionIds.has(sectionId)
  const isFocusedShortcutsPane =
    activeSectionId === 'shortcuts' && settingsSearchQuery.trim() === ''
  const isFocusedSetupGuidePane =
    activeSectionId === 'setup-guide' && settingsSearchQuery.trim() === ''

  return (
    <div
      ref={setSettingsRootNode}
      className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background"
    >
      <SettingsSidebar
        activeSectionId={activeSectionId}
        generalGroups={generalNavGroups}
        repoSections={repoNavSections}
        hasRepos={repos.length > 0}
        searchQuery={settingsSearchInputQuery}
        searchInputRef={searchInputRef}
        onBack={closeSettingsPageWithPromptGuard}
        onSearchChange={setSettingsSearchQuery}
        onSelectSection={scrollToSection}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={setContentScrollNode}
          className={cn(
            'min-h-0 flex-1',
            isFocusedShortcutsPane ? 'overflow-hidden' : 'overflow-y-auto scrollbar-sleek'
          )}
        >
          <div
            className={cn(
              'mx-auto flex w-full flex-col gap-10 px-8 pt-10',
              isFocusedShortcutsPane ? 'h-full pb-6' : 'pb-24',
              isFocusedSetupGuidePane ? 'max-w-6xl' : 'max-w-4xl'
            )}
          >
            {visibleNavSections.length === 0 ? (
              <div className="flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.Settings.3c88ec55d6',
                  'No settings found for "'
                )}
                {settingsSearchQuery.trim()}
                {translate('auto.components.settings.Settings.add3b97ee6', '"')}
              </div>
            ) : (
              <ActiveSettingsSectionProvider value={activeSectionId}>
                <SettingsSection
                  id="agents"
                  title={translate('auto.components.settings.Settings.8afa676615', 'Agents')}
                  description={translate(
                    'auto.components.settings.Settings.ec1ba547f7',
                    'Manage AI agents, set a default, and customize commands.'
                  )}
                  searchEntries={getSectionSearchEntries('agents')}
                >
                  {isSectionMounted('agents') ? (
                    <AgentsPane
                      settings={settings}
                      updateSettings={updateSettings}
                      wslSupportedPlatform={wslSupportedPlatform}
                      wslAvailable={windowsTerminalCapabilities.wslAvailable}
                      wslDistros={windowsTerminalCapabilities.wslDistros}
                      wslCapabilitiesLoading={windowsTerminalCapabilities.isLoading}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="accounts"
                  title={translate(
                    'auto.components.settings.Settings.ad6c529693',
                    'AI Provider Accounts'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.21f09426ea',
                    'Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them.'
                  )}
                  badge={translate(
                    'auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf',
                    'Optional'
                  )}
                  searchEntries={getSectionSearchEntries('accounts')}
                >
                  {isSectionMounted('accounts') ? (
                    <AccountsPane
                      settings={settings}
                      updateSettings={updateSettings}
                      wslSupportedPlatform={wslSupportedPlatform}
                      wslAvailable={windowsTerminalCapabilities.wslAvailable}
                      wslDistros={windowsTerminalCapabilities.wslDistros}
                      wslCapabilitiesLoading={windowsTerminalCapabilities.isLoading}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="orchestration"
                  title={translate('auto.components.settings.Settings.00c3a7950d', 'Orchestration')}
                  description={translate(
                    'auto.components.settings.Settings.475980f53d',
                    'Coordinate multiple coding agents through Orca.'
                  )}
                  searchEntries={getSectionSearchEntries('orchestration')}
                >
                  {isSectionMounted('orchestration') ? <OrchestrationPane /> : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <>
                    <SettingsSection
                      id="computer-use"
                      title={translate(
                        'auto.components.settings.Settings.c9841721cb',
                        'Computer Use'
                      )}
                      description={translate(
                        'auto.components.settings.Settings.7118953f14',
                        'Enable agents to control any app on your computer.'
                      )}
                      searchEntries={getSectionSearchEntries('computer-use')}
                    >
                      {isSectionMounted('computer-use') ? <ComputerUsePane /> : null}
                    </SettingsSection>

                    <SettingsSection
                      id="voice"
                      title={translate('auto.components.settings.Settings.5063bb47a5', 'Voice')}
                      description={translate(
                        'auto.components.settings.Settings.eb1176a14e',
                        'Local speech-to-text dictation with on-device models.'
                      )}
                      searchEntries={getSectionSearchEntries('voice')}
                    >
                      {isSectionMounted('voice') ? (
                        <VoicePane settings={settings} updateSettings={updateSettings} />
                      ) : null}
                    </SettingsSection>
                  </>
                ) : null}

                <SettingsSection
                  id="setup-guide"
                  title={translate(
                    'auto.components.settings.Settings.6d119427ef',
                    'Onboarding checklist'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.6855b0f77d',
                    'Finish the core workflows that make Orca useful for parallel agent work.'
                  )}
                  searchEntries={getSectionSearchEntries('setup-guide')}
                  bodyClassName="overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
                >
                  {isSectionMounted('setup-guide') ? <SettingsSetupGuidePane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="general"
                  title={translate('auto.components.settings.Settings.7807c11c4d', 'General')}
                  description={translate(
                    'auto.components.settings.Settings.f9b77539fd',
                    'Workspace defaults, app setup, and maintenance.'
                  )}
                  searchEntries={getSectionSearchEntries('general')}
                >
                  {isSectionMounted('general') ? (
                    <GeneralPane
                      settings={settings}
                      updateSettings={updateSettings}
                      wslSupportedPlatform={wslSupportedPlatform}
                      wslAvailable={windowsTerminalCapabilities.wslAvailable}
                      wslCapabilitiesLoading={windowsTerminalCapabilities.isLoading}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="integrations"
                  title={translate('auto.components.settings.Settings.c9ca101a3b', 'Integrations')}
                  description={translate(
                    'auto.components.settings.Settings.b07041697f',
                    'Connect GitHub, GitLab, Linear, and source-hosting services.'
                  )}
                  searchEntries={getSectionSearchEntries('integrations')}
                >
                  {isSectionMounted('integrations') ? <IntegrationsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="git"
                  title={translate(
                    'auto.components.settings.Settings.70100f94c7',
                    'Git & Source Control'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.cfa34f4465',
                    'Branch naming, base refs, attribution, and Git AI Author.'
                  )}
                  searchEntries={getSectionSearchEntries('git')}
                  forceVisible={hasUnsavedSourceControlAiPromptChanges}
                >
                  {isSectionMounted('git') ? (
                    <>
                      <GitPane
                        settings={settings}
                        updateSettings={updateSettings}
                        writeSourceControlAiSettings={writeSourceControlAiSettings}
                        displayedGitUsername={displayedGitUsername}
                        hasUnsavedBranchPromptChanges={hasUnsavedBranchPromptChanges}
                        onBranchPromptDirtyChange={setHasUnsavedBranchPromptChanges}
                        branchPromptDiscardSignal={sourceControlAiPromptDiscardSignal}
                        settingsSearchQuery={settingsSearchQuery}
                      />
                      <CommitMessageAiPane
                        settings={settings}
                        updateSettings={updateSettings}
                        writeSourceControlAiSettings={writeSourceControlAiSettings}
                        onCustomPromptDirtyChange={setHasUnsavedCommitPromptChanges}
                        customPromptDiscardSignal={sourceControlAiPromptDiscardSignal}
                        settingsSearchQuery={settingsSearchQuery}
                      />
                    </>
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="tasks"
                  title={translate('auto.components.settings.Settings.11faa2f7dd', 'Task Sources')}
                  description={translate(
                    'auto.components.settings.Settings.dd72ed437a',
                    'Choose which task providers appear in the Tasks page and sidebar.'
                  )}
                  searchEntries={getSectionSearchEntries('tasks')}
                >
                  {isSectionMounted('tasks') ? (
                    <TasksPane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="terminal"
                  title={translate('auto.components.settings.Settings.3de4bbb841', 'Terminal')}
                  description={translate(
                    'auto.components.settings.Settings.b79b5b31e9',
                    'Shells, renderer, sessions, and terminal behavior.'
                  )}
                  searchEntries={getSectionSearchEntries('terminal')}
                >
                  {isSectionMounted('terminal') ? (
                    <TerminalPane
                      settings={settings}
                      updateSettings={updateSettings}
                      scrollbackMode={scrollbackMode}
                      setScrollbackMode={setScrollbackMode}
                      wslAvailable={windowsTerminalCapabilities.wslAvailable}
                      wslDistros={windowsTerminalCapabilities.wslDistros}
                      wslCapabilitiesLoading={windowsTerminalCapabilities.isLoading}
                      pwshAvailable={windowsTerminalCapabilities.pwshAvailable}
                      gitBashAvailable={windowsTerminalCapabilities.gitBashAvailable}
                      isWindowsTerminalHost={isWindowsTerminalHost}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="quick-commands"
                  title={translate(
                    'auto.components.settings.Settings.13d4fe30ad',
                    'Quick Commands'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.6742c7932c',
                    'Saved terminal commands, scoped globally or per project.'
                  )}
                  searchEntries={getSectionSearchEntries('quick-commands')}
                >
                  {isSectionMounted('quick-commands') ? (
                    <QuickCommandsPane
                      settings={settings}
                      updateSettings={updateSettings}
                      addCommandIntentSignal={quickCommandAddIntentSignal}
                    />
                  ) : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <SettingsSection
                    id="browser"
                    title={translate('auto.components.settings.Settings.c46215ea03', 'Browser')}
                    description={translate(
                      'auto.components.settings.Settings.ad9788036f',
                      'Home page, link routing, and session cookies.'
                    )}
                    searchEntries={getSectionSearchEntries('browser')}
                  >
                    {isSectionMounted('browser') ? (
                      <BrowserPane
                        settings={settings}
                        updateSettings={updateSettings}
                        onOpenComputerUse={openComputerUseFromBrowser}
                      />
                    ) : null}
                  </SettingsSection>
                ) : null}

                {showDesktopOnlySettings && isMac ? (
                  <SettingsSection
                    id="mobile-emulator"
                    title={translate(
                      'auto.components.settings.Settings.f75daf1002',
                      'Mobile Emulator'
                    )}
                    description={translate(
                      'auto.components.settings.Settings.01f9d36292',
                      'Configure mobile emulator support for Orca and coding agents.'
                    )}
                    searchEntries={getSectionSearchEntries('mobile-emulator')}
                  >
                    {isSectionMounted('mobile-emulator') ? (
                      <MobileEmulatorSettingsPane
                        settings={settings}
                        updateSettings={updateSettings}
                      />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="floating-workspace"
                  title={translate(
                    'auto.components.settings.Settings.3eb22a3ada',
                    'Floating Workspace'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.3d9adfe6a5',
                    'Global terminal, browser, and markdown tabs.'
                  )}
                  searchEntries={getSectionSearchEntries('floating-workspace')}
                >
                  {isSectionMounted('floating-workspace') ? (
                    <FloatingWorkspacePane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="appearance"
                  title={translate('auto.components.settings.Settings.2b4474780a', 'Appearance')}
                  description={translate(
                    'auto.components.settings.Settings.6d1a27e193',
                    'Theme, zoom, app and terminal appearance, sidebars, and status bar.'
                  )}
                  searchEntries={getSectionSearchEntries('appearance')}
                >
                  {isSectionMounted('appearance') ? (
                    <AppearancePane
                      settings={settings}
                      updateSettings={updateSettings}
                      applyTheme={applyTheme}
                      fontSuggestions={fontSuggestions}
                      terminalFontSuggestions={fontSuggestions.filter(
                        (font) => font !== DEFAULT_APP_FONT_FAMILY
                      )}
                      systemPrefersDark={systemPrefersDark}
                      ghostty={ghostty}
                      warpThemes={warpThemes}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="input"
                  title={translate(
                    'auto.components.settings.Settings.d7a3e635b6',
                    'Input & Editing'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.d0b7021d64',
                    'Selection and editing behavior.'
                  )}
                  searchEntries={getSectionSearchEntries('input')}
                >
                  <InputPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <SettingsSection
                    id="notifications"
                    title={translate(
                      'auto.components.settings.Settings.9907545fa3',
                      'Notifications'
                    )}
                    description={translate(
                      'auto.components.settings.Settings.7210ac09c4',
                      'Native desktop notifications for agent activity and terminal events.'
                    )}
                    searchEntries={getSectionSearchEntries('notifications')}
                  >
                    {isSectionMounted('notifications') ? (
                      <NotificationsPane settings={settings} updateSettings={updateSettings} />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="shortcuts"
                  title={translate('auto.components.settings.Settings.23bf7a1ad4', 'Shortcuts')}
                  description={translate(
                    'auto.components.settings.Settings.a737a4bb22',
                    'Keyboard shortcuts for common actions.'
                  )}
                  searchEntries={getSectionSearchEntries('shortcuts')}
                  className={
                    isFocusedShortcutsPane
                      ? 'flex min-h-0 flex-1 flex-col space-y-0 gap-6'
                      : undefined
                  }
                  bodyClassName={
                    isFocusedShortcutsPane ? 'min-h-0 flex-1 overflow-hidden' : undefined
                  }
                >
                  {isSectionMounted('shortcuts') ? <ShortcutsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="stats"
                  title={translate('auto.components.settings.Settings.954a8f5aef', 'Stats & Usage')}
                  description={translate(
                    'auto.components.settings.Settings.8acf3f22e0',
                    'Orca stats plus Claude, Codex, and OpenCode usage analytics.'
                  )}
                  searchEntries={getSectionSearchEntries('stats')}
                >
                  {isSectionMounted('stats') ? <StatsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="servers"
                  title={translate(
                    'auto.components.settings.Settings.bd0181eeca',
                    'Remote Orca Servers'
                  )}
                  badge="Beta"
                  description={
                    isWebClient
                      ? translate(
                          'auto.components.settings.Settings.7686cb5c36',
                          'Connect this browser to a saved Orca server.'
                        )
                      : translate(
                          'auto.components.settings.Settings.b5ee17826b',
                          'Switch between local desktop mode and paired remote Orca runtimes.'
                        )
                  }
                  searchEntries={getSectionSearchEntries('servers')}
                >
                  {isSectionMounted('servers') ? (
                    <RuntimeEnvironmentsPane
                      settings={settings}
                      switchRuntimeEnvironment={switchRuntimeEnvironment}
                      canGeneratePairingUrl={!isWebClient}
                      allowLocalRuntime={!isWebClient}
                    />
                  ) : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <>
                    <SettingsSection
                      id="ssh"
                      title={translate('auto.components.settings.Settings.9b02492d1f', 'SSH Hosts')}
                      description={translate(
                        'auto.components.settings.Settings.c2ee313198',
                        'Remote SSH hosts for files, terminals, and git.'
                      )}
                      searchEntries={getSectionSearchEntries('ssh')}
                    >
                      {isSectionMounted('ssh') ? <SshPane /> : null}
                    </SettingsSection>

                    <SettingsSection
                      id="mobile"
                      title={translate('auto.components.settings.Settings.c40dadaac8', 'Mobile')}
                      badge="Beta"
                      description={translate(
                        'auto.components.settings.Settings.c6c01ac209',
                        'Control terminals and agents from your phone.'
                      )}
                      searchEntries={getSectionSearchEntries('mobile')}
                    >
                      {isSectionMounted('mobile') ? (
                        <MobileSettingsPane settings={settings} updateSettings={updateSettings} />
                      ) : null}
                    </SettingsSection>
                  </>
                ) : null}

                {showDesktopOnlySettings && isMac ? (
                  <SettingsSection
                    id="developer-permissions"
                    title={translate(
                      'auto.components.settings.Settings.65660d4548',
                      'macOS Permissions'
                    )}
                    description={translate(
                      'auto.components.settings.Settings.9b83cc62c2',
                      'macOS privacy access for terminal-launched developer tools.'
                    )}
                    searchEntries={getSectionSearchEntries('developer-permissions')}
                  >
                    {isSectionMounted('developer-permissions') ? (
                      <DeveloperPermissionsPane />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="privacy"
                  title={translate(
                    'auto.components.settings.Settings.d7e3f62d70',
                    'Privacy & Telemetry'
                  )}
                  description={translate(
                    'auto.components.settings.Settings.c1b43dc4e2',
                    'Anonymous usage data and telemetry controls.'
                  )}
                  searchEntries={getSectionSearchEntries('privacy')}
                >
                  {isSectionMounted('privacy') ? <PrivacyPane settings={settings} /> : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <SettingsSection
                    id="advanced"
                    title={translate('auto.components.settings.Settings.1c87f8d024', 'Advanced')}
                    description={translate(
                      'auto.components.settings.Settings.499c1cd7f9',
                      'Low-level compatibility settings for troubleshooting.'
                    )}
                    searchEntries={getSectionSearchEntries('advanced')}
                  >
                    {isSectionMounted('advanced') ? (
                      <AdvancedPane settings={settings} updateSettings={updateSettings} />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="experimental"
                  title={translate('auto.components.settings.Settings.8b017f2506', 'Experimental')}
                  description={translate(
                    'auto.components.settings.Settings.075341c763',
                    'New features that are still taking shape. Give them a try.'
                  )}
                  searchEntries={getSectionSearchEntries('experimental')}
                >
                  {isSectionMounted('experimental') ? (
                    <ExperimentalPane
                      settings={settings}
                      updateSettings={updateSettings}
                      hiddenExperimentalUnlocked={hiddenExperimentalUnlocked}
                    />
                  ) : null}
                </SettingsSection>

                {repos.map((repo) => {
                  const repoSectionId = `repo-${repo.id}`
                  const repoHooksState = repoHooksMap[repo.id]

                  return (
                    <SettingsSection
                      key={repo.id}
                      id={repoSectionId}
                      title={translate(
                        'auto.components.settings.Settings.3bf149e873',
                        'Project Settings > {{value0}}',
                        { value0: repo.displayName }
                      )}
                      description={repo.path}
                      searchEntries={getSectionSearchEntries(repoSectionId)}
                    >
                      {isSectionMounted(repoSectionId) ? (
                        <RepositoryPane
                          repo={repo}
                          yamlHooks={repoHooksState?.hooks ?? null}
                          hasHooksFile={repoHooksState?.hasHooks ?? false}
                          hooksInspectionReady={Boolean(repoHooksState)}
                          mayNeedUpdate={repoHooksState?.mayNeedUpdate ?? false}
                          updateRepo={updateRepo}
                          removeProject={removeProject}
                        />
                      ) : null}
                    </SettingsSection>
                  )
                })}
              </ActiveSettingsSectionProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
