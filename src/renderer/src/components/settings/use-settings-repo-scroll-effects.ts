import { useEffect, useRef, useState } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
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

// A stopped WSL distro's repo stays "checking"; re-ask soon, and whenever the window comes back.
const UNREAD_HOOKS_RETRY_MS = 10_000

function onceOnRetrySignal(retry: () => void): () => void {
  let fired = false
  const fire = (): void => {
    if (!fired && document.visibilityState !== 'hidden') {
      fired = true
      dispose()
      retry()
    }
  }
  const timer = setTimeout(fire, UNREAD_HOOKS_RETRY_MS)
  window.addEventListener('focus', fire)
  document.addEventListener('visibilitychange', fire)
  function dispose(): void {
    clearTimeout(timer)
    window.removeEventListener('focus', fire)
    document.removeEventListener('visibilitychange', fire)
  }
  return dispose
}

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
  const [unreadHooksRetryTick, setUnreadHooksRetryTick] = useState(0)
  // On a retry, only repos whose distro refused the last check are asked again.
  const unreadHooksRef = useRef<ReadonlySet<string> | null>(null)

  useEffect(() => {
    const repoHostIdentitySet = new Set<string>(repos.map(getRepoHostIdentity))
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
    let disposeRetry: (() => void) | null = null
    const requestSeq = ++repoHooksRequestSeqRef.current
    const liveRepoHostIdentities = new Set(repos.map(getRepoHostIdentity))
    const retryOnly = unreadHooksRef.current
    unreadHooksRef.current = null
    const unread = new Set<string>()

    void Promise.all(
      neededRepos
        .filter((repo) => !retryOnly || retryOnly.has(getRepoHostIdentity(repo)))
        .map(async (repo) => {
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
            // Showing Settings is no act on the repo's WSL distro (E9).
            const result = await checkRuntimeHooks(hostId, repo.id, { background: true })
            if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
              return
            }
            // Unread is not "no orca.yaml": leave the pane checking rather than offer local-only commands.
            if (result.unavailable) {
              unread.add(repoHostIdentity)
              return
            }
            setRepoHooksMap((previous) => {
              if (!liveRepoHostIdentities.has(repoHostIdentity)) {
                return previous
              }
              return { ...previous, [repoHostIdentity]: result }
            })
          } catch {
            // Retain known hook settings through transient read failures.
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
    ).then(() => {
      if (!stale && unread.size > 0) {
        disposeRetry = onceOnRetrySignal(() => {
          unreadHooksRef.current = unread
          setUnreadHooksRetryTick((tick) => tick + 1)
        })
      }
    })

    return () => {
      stale = true
      disposeRetry?.()
    }
  }, [neededRepos, repoHooksRequestSeqRef, repos, setRepoHooksMap, unreadHooksRetryTick])

  useEffect(() => {
    const scrollTargetId = pendingScrollTargetRef.current
    const pendingNavSectionId = pendingNavSectionRef.current
    // This pass re-evaluates the pending target; cancel the previous watch first.
    cancelPendingSettingsDeepLinkTargetWatch(pendingScrollTargetWatchRef)

    // Subsection links clear filters that could hide their rows; pane links retain filtering to force the pane open.
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
      // Inactive panes have no DOM; activate before locating the subsection next render.
      if (activeSectionId !== pendingNavSectionId) {
        setActiveSectionId(pendingNavSectionId)
        return
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      if (scrollTargetId !== pendingNavSectionId) {
        // Retain pending refs until the lazy subsection mounts.
        if (!getSettingsScrollTarget(scrollTargetId, container)) {
          // Async rows may mount without another effect pass; observe their arrival.
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
