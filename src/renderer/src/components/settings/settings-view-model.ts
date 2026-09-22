import { useCallback } from 'react'
import type { SettingsNavGroup } from '@/lib/settings-navigation-types'
import { translate } from '@/i18n/i18n'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import { getSettingsNavGroupDefinitionsForSearch } from './settings-navigation-foundations'

export function useSettingsNavigationActions(
  model: SettingsStoreModel,
  interactions: SettingsInteractionController
) {
  const {
    activeSectionId,
    setActiveSectionId,
    setPendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery
  } = model
  const {
    confirmDiscardSourceControlAiPromptChanges,
    contentScrollRef,
    pendingNavSectionRef,
    pendingScrollTargetRef
  } = interactions
  const scrollToSection = useCallback(
    async (sectionId: string): Promise<void> => {
      if (sectionId !== activeSectionId && !(await confirmDiscardSourceControlAiPromptChanges())) {
        return
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      if (settingsSearchQuery.trim() !== '') {
        // Why: clear the search filter so selecting a result shows that pane, not the stale query's.
        setSettingsSearchQuery('')
      }
      setActiveSectionId(sectionId)
    },
    [
      activeSectionId,
      confirmDiscardSourceControlAiPromptChanges,
      contentScrollRef,
      setActiveSectionId,
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
    // Why: pending refs don't schedule a render; bump state to rerun the jump effect.
    setPendingNavRequestTick((tick) => tick + 1)
  }, [
    confirmDiscardSourceControlAiPromptChanges,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    setPendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery
  ])

  return { scrollToSection, openComputerUseFromBrowser }
}

export type SettingsNavigationActions = ReturnType<typeof useSettingsNavigationActions>

export function buildSettingsViewModel(
  model: SettingsStoreModel,
  navigation: SettingsNavigationModel
) {
  const generalNavSections = navigation.visibleNavSections.filter(
    (section) => !section.id.startsWith('repo-')
  )
  const generalNavGroupDefinitions = getSettingsNavGroupDefinitionsForSearch(
    navigation.visibleNavSections,
    model.settingsSearchQuery
  )
  const generalNavGroups: SettingsNavGroup[] = generalNavGroupDefinitions
    .map((group) => ({
      id: group.id,
      title: translate(group.titleKey, group.titleDefault),
      sections: generalNavSections.filter((section) => section.group === group.id)
    }))
    .filter((group) => group.sections.length > 0 || group.id === 'setup')
  const repoNavSections = navigation.visibleNavSections
    .filter((section) => section.id.startsWith('repo-'))
    .map((section) => {
      const repo = model.repos.find((entry) => entry.id === section.id.replace('repo-', ''))
      return {
        ...section,
        badgeColor: repo?.badgeColor,
        isRemote: !!repo?.connectionId,
        repoIcon: repo?.repoIcon,
        upstream: repo?.upstream
      }
    })
  const isSectionMounted = (sectionId: string): boolean =>
    navigation.neededSectionIds.has(sectionId)
  const isFocusedShortcutsPane =
    model.activeSectionId === 'shortcuts' && model.settingsSearchQuery.trim() === ''
  const isFocusedSetupGuidePane =
    model.activeSectionId === 'setup-guide' && model.settingsSearchQuery.trim() === ''

  return {
    generalNavGroups,
    repoNavSections,
    isSectionMounted,
    isFocusedShortcutsPane,
    isFocusedSetupGuidePane
  }
}

export type SettingsViewModel = ReturnType<typeof buildSettingsViewModel>
