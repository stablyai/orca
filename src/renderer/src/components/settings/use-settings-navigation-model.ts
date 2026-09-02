import { useCallback, useMemo } from 'react'
import { applyDocumentTheme } from '@/lib/document-theme'
import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import type { SettingsNavInstallStatus } from '@/lib/settings-navigation-types'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  getAgentSkillNavInstallStatus,
  getLinearAgentSkillNavInstallStatus
} from '@/lib/agent-skill-nav-install-status'
import { getProjectHostSetupProjectionFromState } from '../../store/selectors'
import { getSettingsSectionSearchEntries, rankSettingsSearchItems } from './settings-search'
import { deriveNeededSectionIds } from './settings-load-performance'
import { SCROLLBACK_PRESETS_ROWS } from './SettingsConstants'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import { hasReadyVoiceModel } from './settings-navigation-foundations'

export function useSettingsNavigationModel(
  model: SettingsStoreModel,
  interactions: SettingsInteractionController
) {
  // Why: recompute scrollback mode only when the row value changes, not on every settings mutation.
  if (model.settings?.terminalScrollbackRows !== model.prevScrollbackRows) {
    model.setPrevScrollbackRows(model.settings?.terminalScrollbackRows)
    if (model.settings) {
      model.setScrollbackMode(
        SCROLLBACK_PRESETS_ROWS.includes(
          model.settings.terminalScrollbackRows as (typeof SCROLLBACK_PRESETS_ROWS)[number]
        )
          ? 'preset'
          : 'custom'
      )
    }
  }

  const applyTheme = useCallback((theme: 'system' | 'dark' | 'light') => {
    applyDocumentTheme(theme)
  }, [])

  const displayedGitUsername = model.repos[0]?.gitUsername ?? ''
  const baseNavSections = useSettingsNavigationMetadata()
  const { installed: orchestrationSkillInstalled, loading: orchestrationSkillLoading } =
    model.orchestrationSkill
  const {
    installed: linearSkillInstalled,
    loading: linearSkillLoading,
    skills: linearSkills
  } = model.linearSkill
  const { installed: computerUseSkillInstalled, loading: computerUseSkillLoading } =
    model.computerUseSkill
  const capabilityInstallStatusBySectionId = useMemo(() => {
    const applicableFreshnessInventory = model.skillFreshnessApplies
      ? model.skillFreshnessInventory
      : null
    const next = new Map<string, SettingsNavInstallStatus>([
      [
        'orchestration',
        getAgentSkillNavInstallStatus({
          name: ORCHESTRATION_SKILL_NAME,
          installed: orchestrationSkillInstalled,
          loading: orchestrationSkillLoading,
          inventory: applicableFreshnessInventory
        })
      ]
    ])
    if (model.linearConnected) {
      next.set(
        'linear',
        getLinearAgentSkillNavInstallStatus({
          skills: linearSkills,
          installed: linearSkillInstalled,
          loading: linearSkillLoading,
          inventory: applicableFreshnessInventory
        })
      )
    }
    if (model.showDesktopOnlySettings) {
      next.set(
        'computer-use',
        getAgentSkillNavInstallStatus({
          name: COMPUTER_USE_SKILL_NAME,
          installed: computerUseSkillInstalled,
          loading: computerUseSkillLoading,
          inventory: applicableFreshnessInventory
        })
      )
      if (model.settings) {
        next.set(
          'voice',
          model.voiceModelStatesLoading
            ? 'checking'
            : hasReadyVoiceModel(model.settings, model.modelStates)
              ? 'installed'
              : 'install'
        )
      }
    }
    return next
  }, [
    computerUseSkillInstalled,
    computerUseSkillLoading,
    linearSkillInstalled,
    linearSkillLoading,
    linearSkills,
    model.linearConnected,
    model.modelStates,
    model.settings,
    model.showDesktopOnlySettings,
    model.skillFreshnessApplies,
    model.skillFreshnessInventory,
    model.voiceModelStatesLoading,
    orchestrationSkillInstalled,
    orchestrationSkillLoading
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
  const getSectionSearchEntries = (sectionId: string) => {
    const section = navSectionById.get(sectionId)
    return section ? getSettingsSectionSearchEntries(section) : []
  }

  const visibleNavSections = useMemo(() => {
    const rankedSections = rankSettingsSearchItems(
      model.settingsSearchQuery,
      navSections,
      getSettingsSectionSearchEntries
    ).map(({ item }) => item)
    if (
      !interactions.hasUnsavedSourceControlAiPromptChanges ||
      rankedSections.some((section) => section.id === 'git')
    ) {
      return rankedSections
    }
    const gitSection = navSectionById.get('git')
    return gitSection ? [...rankedSections, gitSection] : rankedSections
  }, [
    interactions.hasUnsavedSourceControlAiPromptChanges,
    navSectionById,
    navSections,
    model.settingsSearchQuery
  ])
  const visibleSectionIds = useMemo(
    () => new Set(visibleNavSections.map((section) => section.id)),
    [visibleNavSections]
  )
  const projectByRepoId = useMemo(() => {
    const projection = getProjectHostSetupProjectionFromState({
      repos: model.repos,
      projects: model.projects,
      projectHostSetups: model.projectHostSetups
    })
    const projectById = new Map(projection.projects.map((project) => [project.id, project]))
    const nextProjectByRepoId = new Map<string, (typeof projection.projects)[number]>()
    for (const setup of projection.setups) {
      const project = projectById.get(setup.projectId)
      if (project && setup.repoId.trim()) {
        nextProjectByRepoId.set(setup.repoId, project)
      }
    }
    return nextProjectByRepoId
  }, [model.projectHostSetups, model.projects, model.repos])
  const neededSectionIds = useMemo(
    () =>
      deriveNeededSectionIds({
        navSectionIds: navSections.map((section) => section.id),
        mountedSectionIds: model.mountedSectionIds,
        activeSectionId: model.activeSectionId,
        pendingSectionId: interactions.pendingNavSectionRef.current,
        query: model.settingsSearchQuery,
        visibleSectionIds
      }),
    [
      model.activeSectionId,
      model.mountedSectionIds,
      interactions.pendingNavSectionRef,
      navSections,
      model.settingsSearchQuery,
      visibleSectionIds
    ]
  )

  return {
    applyTheme,
    displayedGitUsername,
    navSections,
    getSectionSearchEntries,
    visibleNavSections,
    visibleSectionIds,
    projectByRepoId,
    neededSectionIds
  }
}

export type SettingsNavigationModel = ReturnType<typeof useSettingsNavigationModel>
