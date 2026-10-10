import { useEffect } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { getRepoHostIdentity } from '../../store/slices/repo-host-identity'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'
import { watchForSettingsDeepLinkTarget } from './settings-deep-link-target-watcher'
import {
  cancelPendingSettingsDeepLinkTargetWatch,
  cancelPendingSettingsSubsectionScrollFrame,
  getFallbackVisibleSection,
  getSettingsScrollTarget,
  scrollSubsectionIntoView
} from './settings-navigation-foundations'

export function useSettingsRepoScrollEffects(
  model: SettingsStoreModel,
  interactions: SettingsInteractionController,
  navigation: SettingsNavigationModel,
  terminal: SettingsTerminalModel
): void {
  const {
    activeSectionId,
    pendingNavRequestTick,
    repos,
    setActiveSectionId,
    setPendingNavRequestTick,
    setRepoHooksMap,
    setSettingsSearchQuery,
    settingsSearchQuery
  } = model
  const {
    contentScrollRef,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    pendingScrollTargetWatchRef,
    pendingSubsectionScrollFrameRef,
    repoHooksRequestSeqRef
  } = interactions
  const { visibleNavSections, visibleSectionIds } = navigation
  const { neededRepos } = terminal

  useEffect(() => {
    const repoHostIdentitySet = new Set(repos.map(getRepoHostIdentity))
    setRepoHooksMap((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([identity]) => repoHostIdentitySet.has(identity))
      ) as Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [repos, setRepoHooksMap])

  useEffect(() => {
    if (neededRepos.length === 0) {
      return
    }

    let stale = false
    const requestSeq = ++repoHooksRequestSeqRef.current
    const liveRepoHostIdentities = new Set(repos.map(getRepoHostIdentity))

    void Promise.all(
      neededRepos.map(async (repo) => {
        const repoHostIdentity = getRepoHostIdentity(repo)
        if (isFolderRepo(repo)) {
          setRepoHooksMap((previous) => {
            if (previous[repoHostIdentity]) {
              return previous
            }
            return {
              ...previous,
              [repoHostIdentity]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
          return
        }
        try {
          const hostId = getRepoExecutionHostId(repo)
          const parsedHost = parseExecutionHostId(hostId)
          const result = await checkRuntimeHooks(
            {
              activeRuntimeEnvironmentId:
                parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
            },
            repo.id,
            hostId
          )
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!liveRepoHostIdentities.has(repoHostIdentity)) {
              return previous
            }
            return { ...previous, [repoHostIdentity]: result }
          })
        } catch {
          // Keep last known value on transient failures.
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!liveRepoHostIdentities.has(repoHostIdentity)) {
              return previous
            }
            if (previous[repoHostIdentity]) {
              return previous
            }
            return {
              ...previous,
              [repoHostIdentity]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
        }
      })
    )

    return () => {
      stale = true
    }
  }, [neededRepos, repoHooksRequestSeqRef, repos, setRepoHooksMap])

  useEffect(() => {
    const scrollTargetId = pendingScrollTargetRef.current
    const pendingNavSectionId = pendingNavSectionRef.current
    // Why: this pass re-decides whether to wait for the target, so drop any watch armed by the previous one.
    cancelPendingSettingsDeepLinkTargetWatch(pendingScrollTargetWatchRef)

    // Why: subsection deep links clear a stale filter that could hide the target row; pane-level links keep it to force-open the matching section.
    if (
      scrollTargetId &&
      pendingNavSectionId &&
      scrollTargetId !== pendingNavSectionId &&
      settingsSearchQuery.trim() !== ''
    ) {
      setSettingsSearchQuery('')
      return
    }

    if (scrollTargetId && pendingNavSectionId && visibleSectionIds.has(pendingNavSectionId)) {
      // Why: inactive panes don't render; activate the pane first, then find the subsection next render.
      if (activeSectionId !== pendingNavSectionId) {
        setActiveSectionId(pendingNavSectionId)
        return
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      // Why: deep links can target a row inside the already-visible pane.
      if (scrollTargetId !== pendingNavSectionId) {
        // Why: target can arrive before the lazy section mounts; keep pending refs until it does.
        if (!getSettingsScrollTarget(scrollTargetId, container)) {
          // Why: async panes (the server list, say) mount rows after this pass, and nothing else re-runs the effect.
          pendingScrollTargetWatchRef.current = watchForSettingsDeepLinkTarget({
            root: container,
            isTargetPresent: () =>
              getSettingsScrollTarget(scrollTargetId, contentScrollRef.current) !== null,
            onTargetPresent: () => setPendingNavRequestTick((tick) => tick + 1)
          })
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
    contentScrollRef,
    pendingNavRequestTick,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    pendingScrollTargetWatchRef,
    pendingSubsectionScrollFrameRef,
    setActiveSectionId,
    setPendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery,
    visibleSectionIds,
    visibleNavSections
  ])
}
