import { useCallback } from 'react'
import type { SettingsNavGroup } from '@/components/settings/navigation/settings-navigation-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from '../navigation/use-settings-navigation-model'
import {
  cancelPendingSettingsDeepLinkTargetWatch,
  getSettingsNavGroupDefinitionsForSearch
} from '../navigation/settings-navigation-foundations'
import type { SettingsSearchResult } from '../navigation/settings-search-results'

export function useSettingsNavigationActions(
  model: Pick<
    SettingsStoreModel,
    | 'setHighlightedSettingsTarget'
    | 'generalSubPage'
    | 'setGeneralSubPage'
    | 'activeSectionId'
    | 'setActiveSectionId'
    | 'setPendingNavRequestTick'
    | 'setSettingsSearchQuery'
    | 'settingsSearchQuery'
    | 'releaseNativeAccounts'
  >,
  interactions: SettingsInteractionController
) {
  const {
    activeSectionId,
    setHighlightedSettingsTarget,
    setGeneralSubPage,
    setActiveSectionId,
    setPendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery,
    releaseNativeAccounts
  } = model
  const {
    confirmDiscardSourceControlAiPromptChanges,
    contentScrollRef,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    pendingScrollTargetWatchRef
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
        // Clear stale filtering when selecting a result’s pane.
        setSettingsSearchQuery('')
      }
      // A plain pane pick supersedes any search or deep-link jump still waiting for its row.
      pendingNavSectionRef.current = null
      pendingScrollTargetRef.current = null
      cancelPendingSettingsDeepLinkTargetWatch(pendingScrollTargetWatchRef)
      setHighlightedSettingsTarget(null)
      setGeneralSubPage(null)
      releaseNativeAccounts()
      setActiveSectionId(sectionId)
    },
    [
      activeSectionId,
      releaseNativeAccounts,
      confirmDiscardSourceControlAiPromptChanges,
      contentScrollRef,
      pendingNavSectionRef,
      pendingScrollTargetRef,
      pendingScrollTargetWatchRef,
      setActiveSectionId,
      setGeneralSubPage,
      setHighlightedSettingsTarget,
      setSettingsSearchQuery,
      settingsSearchQuery
    ]
  )

  const openSettingsSearchResult = useCallback(
    async (result: SettingsSearchResult): Promise<void> => {
      const sectionId = result.section.id
      if (sectionId !== activeSectionId) {
        if (!(await confirmDiscardSourceControlAiPromptChanges())) {
          return
        }
        releaseNativeAccounts()
      }
      setHighlightedSettingsTarget(null)
      pendingNavSectionRef.current = sectionId
      pendingScrollTargetRef.current = result.targetId
      // Pending refs cannot schedule the jump effect; trigger a render.
      setPendingNavRequestTick((tick) => tick + 1)
    },
    [
      activeSectionId,
      confirmDiscardSourceControlAiPromptChanges,
      pendingNavSectionRef,
      pendingScrollTargetRef,
      releaseNativeAccounts,
      setHighlightedSettingsTarget,
      setPendingNavRequestTick
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
    // Pending refs cannot schedule the jump effect; trigger a render.
    setPendingNavRequestTick((tick) => tick + 1)
  }, [
    confirmDiscardSourceControlAiPromptChanges,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    setPendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery
  ])

  return { scrollToSection, openSettingsSearchResult, openComputerUseFromBrowser }
}

export type SettingsNavigationActions = ReturnType<typeof useSettingsNavigationActions>

export function buildSettingsViewModel(
  model: SettingsStoreModel,
  navigation: SettingsNavigationModel,
  t: Translate = translate
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
      title: t(group.titleKey, group.titleDefault),
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
  // Why no query check: search still shows only the active section.
  const isWidePluginsPane = model.activeSectionId === 'plugins'

  return {
    generalNavGroups,
    repoNavSections,
    isSectionMounted,
    isFocusedShortcutsPane,
    isFocusedSetupGuidePane,
    isWidePluginsPane
  }
}

export type SettingsViewModel = ReturnType<typeof buildSettingsViewModel>
