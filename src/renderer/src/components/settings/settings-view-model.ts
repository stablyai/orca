import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import {
  getSettingsEntryHostSelection,
  getSettingsProjectSelectedSetup,
  projectSettingsConcreteSelection,
  type SettingsConcreteSelection
} from './settings-project-list'
import { useCallback, useEffect, useState } from 'react'
import type { SettingsNavGroup } from '@/lib/settings-navigation-types'
import { translate } from '@/i18n/i18n'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import { getSettingsNavGroupDefinitionsForSearch } from './settings-navigation-foundations'

export function useSettingsNavigationActions(
  model: Pick<
    SettingsStoreModel,
    | 'activeSectionId'
    | 'setActiveSectionId'
    | 'setPendingNavRequestTick'
    | 'setSettingsSearchQuery'
    | 'settingsSearchQuery'
  >,
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
        // Clear stale filtering when selecting a result’s pane.
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
  const repoNavSections = navigation.visibleNavSections.filter((section) =>
    section.id.startsWith('repo-')
  )
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

export function useConcreteProjectContinuity(
  model: SettingsStoreModel,
  interactions: SettingsInteractionController
): SettingsStoreModel {
  const {
    activeSectionId: storedActiveSectionId,
    settingsProjectList,
    settingsProjectHostSelection,
    settingsProjectSetupSelection,
    setActiveSectionId,
    setSettingsProjectHostSelection
  } = model
  const [committed, setCommitted] = useState<{
    anchor: SettingsConcreteSelection
    hosts: SettingsStoreModel['settingsProjectHostSelection']
    setups: SettingsStoreModel['settingsProjectSetupSelection']
  } | null>(null)
  const anchor =
    committed?.hosts === settingsProjectHostSelection &&
    committed.setups === settingsProjectSetupSelection
      ? committed.anchor
      : null
  const selection =
    !interactions.pendingNavSectionRef.current && !model.settingsNavigationTarget
      ? projectSettingsConcreteSelection(settingsProjectList, storedActiveSectionId, anchor)
      : null
  const selectedHostId = selection?.hostId
  const selectedSetupId = selection?.setupId
  const activeSectionId = selection?.sectionId ?? storedActiveSectionId
  const hosts = selection
    ? {
        ...settingsProjectHostSelection,
        [activeSectionId.slice('repo-'.length)]: selection.hostId
      }
    : settingsProjectHostSelection
  const setups = selection
    ? {
        ...settingsProjectSetupSelection,
        [activeSectionId.slice('repo-'.length)]: selection.setupId
      }
    : settingsProjectSetupSelection
  useEffect(() => {
    if (selectedHostId !== undefined && selectedSetupId !== undefined) {
      if (storedActiveSectionId !== activeSectionId) {
        setActiveSectionId(activeSectionId)
      }
      const key = activeSectionId.slice('repo-'.length)
      if (
        settingsProjectHostSelection[key] !== selectedHostId ||
        settingsProjectSetupSelection[key] !== selectedSetupId
      ) {
        setSettingsProjectHostSelection(key, selectedHostId, selectedSetupId)
      }
    }
    const entry = settingsProjectList.find(
      (candidate) => `repo-${candidate.selectionKey}` === activeSectionId
    )
    const explicit = entry
      ? getSettingsEntryHostSelection(
          entry,
          settingsProjectHostSelection,
          settingsProjectSetupSelection
        )
      : null
    const setup =
      entry && explicit
        ? getSettingsProjectSelectedSetup(
            entry,
            selectedHostId ?? explicit.hostId,
            selectedSetupId ?? explicit.setupId
          )
        : null
    const next = setup
      ? {
          sectionId: activeSectionId,
          repoId: setup.repoId,
          hostId: setup.hostId,
          setupId: setup.id,
          physicalHostId: getProjectRepoFilterHost(setup)
        }
      : null
    setCommitted((previous) =>
      next
        ? previous &&
          previous.anchor.sectionId === next.sectionId &&
          previous.anchor.repoId === next.repoId &&
          previous.anchor.hostId === next.hostId &&
          previous.anchor.setupId === next.setupId &&
          previous.anchor.physicalHostId === next.physicalHostId &&
          previous.hosts === settingsProjectHostSelection &&
          previous.setups === settingsProjectSetupSelection
          ? previous
          : {
              anchor: next,
              hosts: settingsProjectHostSelection,
              setups: settingsProjectSetupSelection
            }
        : null
    )
  }, [
    activeSectionId,
    storedActiveSectionId,
    settingsProjectList,
    settingsProjectHostSelection,
    settingsProjectSetupSelection,
    setActiveSectionId,
    setSettingsProjectHostSelection,
    selectedHostId,
    selectedSetupId
  ])
  return {
    ...model,
    activeSectionId,
    settingsProjectHostSelection: hosts,
    settingsProjectSetupSelection: setups
  }
}
