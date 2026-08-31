import { useEffect, useMemo, useRef, useState } from 'react'

import {
  getDefaultTaskRepoSelection,
  getTaskProjectPickerGroups,
  normalizeTaskRepoSelection
} from '@/components/task-page-default-repo-selection'
import { areStringSetsEqual } from '@/components/task-page-string-set-equality'
import { buildSelectedReposKey } from '@/components/task-page-work-item-pagination'
import { getTaskPageRepoSourceContext } from './repo-source-context'
import type { Repo } from '../../../../../shared/repo-types'

export function useTaskPageRepoSelection({
  eligibleRepos,
  pageDataPreselectedRepoId,
  defaultRepoSelection
}: {
  eligibleRepos: Repo[]
  pageDataPreselectedRepoId?: string | null
  defaultRepoSelection: string[] | null | undefined
}) {
  // Why: initial selection precedence — explicit preselection > persisted defaultRepoSelection > all eligible; preselection wins so "open tasks for this repo" lands single-repo.
  const resolvedInitialSelection = useMemo<ReadonlySet<string>>(() => {
    const preferred = pageDataPreselectedRepoId
    if (preferred && eligibleRepos.some((repo) => repo.id === preferred)) {
      return new Set([preferred])
    }
    const persisted = defaultRepoSelection
    if (Array.isArray(persisted)) {
      const filtered = persisted.filter((id) => eligibleRepos.some((r) => r.id === id))
      if (filtered.length > 0) {
        return normalizeTaskRepoSelection(eligibleRepos, new Set(filtered))
      }
      // Why: empty after filtering (all persisted repos removed) falls through to the automatic default so the page never renders an empty selection.
    }
    return getDefaultTaskRepoSelection(eligibleRepos)
  }, [eligibleRepos, pageDataPreselectedRepoId, defaultRepoSelection])

  const [repoSelection, setRepoSelection] = useState<ReadonlySet<string>>(resolvedInitialSelection)
  const taskPickerGroups = useMemo(
    () => getTaskProjectPickerGroups(eligibleRepos, repoSelection),
    [eligibleRepos, repoSelection]
  )
  const taskPickerRepos = useMemo(
    () => taskPickerGroups.map((group) => group.repo),
    [taskPickerGroups]
  )

  // Why: prune removed repos and preserve sticky-all (selection == all projects stays == all), without recreating the Set each time and churning the fetch effect.
  const prevTaskPickerCountRef = useRef(taskPickerRepos.length)
  useEffect(() => {
    const prevCount = prevTaskPickerCountRef.current
    prevTaskPickerCountRef.current = taskPickerRepos.length
    const eligibleIds = new Set(eligibleRepos.map((r) => r.id))
    const wasAll = repoSelection.size === prevCount && prevCount > 0
    const pruned = new Set<string>()
    for (const id of repoSelection) {
      if (eligibleIds.has(id)) {
        pruned.add(id)
      }
    }
    if (wasAll) {
      const allNow = new Set(taskPickerRepos.map((repo) => repo.id))
      if (!areStringSetsEqual(allNow, repoSelection)) {
        setRepoSelection(allNow)
      }
      return
    }
    if (pruned.size === 0 && eligibleIds.size === 0) {
      return
    }
    const normalized = normalizeTaskRepoSelection(eligibleRepos, pruned)
    if (!areStringSetsEqual(normalized, repoSelection)) {
      setRepoSelection(normalized)
    }
  }, [eligibleRepos, repoSelection, taskPickerRepos])

  const selectedRepos = useMemo(
    () => eligibleRepos.filter((r) => repoSelection.has(r.id)),
    [eligibleRepos, repoSelection]
  )

  // Why: see buildSelectedReposKey — array-identity deps re-fire on every
  // repos:changed even when the selection is unchanged. The context part is
  // resolved as GitHub, but every provider-independent field (projectId,
  // hostId, projectHostSetupId, repoId) is identical across providers, so the
  // GitLab effect can key off this too — it passes no gitlabProjectRef, so its
  // context carries no providerIdentity of its own. Thread a projectRef into
  // that call and this key needs a GitLab-scoped part.
  const selectedReposKey = useMemo(
    () => buildSelectedReposKey(selectedRepos, (r) => getTaskPageRepoSourceContext(r, 'github')),
    [selectedRepos]
  )

  // Why: many affordances need *a* repo; use the first selected as default, while cross-repo dialogs still let the user override per-action.
  const primaryRepo = selectedRepos[0] ?? null

  return {
    resolvedInitialSelection,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    selectedRepos,
    selectedReposKey,
    primaryRepo
  }
}
