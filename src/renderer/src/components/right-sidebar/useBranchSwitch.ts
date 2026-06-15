import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import { switchRuntimeGitBranch } from '@/runtime/runtime-git-client'
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { BaseRefSearchResult, Worktree } from '../../../../shared/types'
import {
  annotateBranchSwitchCandidates,
  type BranchSwitchCandidate
} from './branch-switch-candidates'

const SEARCH_DEBOUNCE_MS = 200

export function useBranchSwitch(input: {
  repoId: string | null
  worktrees: Worktree[]
  activeWorktreeId: string | null
  activeBranchName: string
  gitContext: RuntimeGitContext
  onSwitched: () => void
}): {
  query: string
  setQuery: (value: string) => void
  loading: boolean
  candidates: BranchSwitchCandidate[]
  isSwitching: boolean
  switchToCandidate: (candidate: BranchSwitchCandidate) => Promise<void>
  createBranch: (name: string) => Promise<void>
} {
  const { repoId, worktrees, activeWorktreeId, activeBranchName, gitContext, onSwitched } = input
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  // Why: searchRuntimeRepoBaseRefDetails expects a settings object with
  // activeRuntimeEnvironmentId, not a bare string — match BaseRefPicker's pattern.
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForRepo(s, repoId)
  )
  const confirm = useConfirmationDialog()

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [refs, setRefs] = useState<BaseRefSearchResult[]>([])
  const [isSwitching, setIsSwitching] = useState(false)
  // Why: a ref blocks overlapping switches across the async confirm/await window
  // — React state updates too late for a rapid double-click. It lives at the
  // public callbacks (not inside runSwitch) so the dirty_conflict→stash
  // recursion still runs.
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!repoId) {
      setRefs([])
      return
    }
    let stale = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      // Why: first arg is a settings object not a raw environment ID — matches
      // the Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> shape the client
      // expects (same pattern as BaseRefPicker.tsx).
      void searchRuntimeRepoBaseRefDetails(
        { activeRuntimeEnvironmentId },
        repoId,
        query,
        50
      )
        .then((results) => {
          if (!stale) { setRefs(results) }
        })
        .catch(() => {
          if (!stale) { setRefs([]) }
        })
        .finally(() => {
          if (!stale) { setLoading(false) }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [repoId, activeRuntimeEnvironmentId, query])

  const candidates = useMemo(
    () =>
      annotateBranchSwitchCandidates({ refs, worktrees, activeWorktreeId, activeBranchName }),
    [refs, worktrees, activeWorktreeId, activeBranchName]
  )

  const runSwitch = useCallback(
    async (branch: string, mode: 'plain' | 'stash' | 'create'): Promise<void> => {
      setIsSwitching(true)
      try {
        const result = await switchRuntimeGitBranch(gitContext, { branch, mode })
        if (result.ok) {
          onSwitched()
          return
        }
        if (result.reason === 'dirty_conflict') {
          const confirmed = await confirm({
            title: translate('auto.branchSwitch.stashTitle', 'Stash changes and switch?'),
            description: translate(
              'auto.branchSwitch.stashBody',
              'Your local changes would be overwritten. Stash them, switch, and re-apply?'
            ),
            confirmLabel: translate('auto.branchSwitch.stashConfirm', 'Stash & switch')
          })
          if (confirmed) { await runSwitch(branch, 'stash') }
          return
        }
        if (result.reason === 'stash_pop_conflict') {
          onSwitched()
          toast.warning(
            translate(
              'auto.branchSwitch.popConflict',
              'Switched, but re-applying your changes conflicted — they are saved in git stash.'
            )
          )
          return
        }
        // result.reason === 'failed'
        toast.error(
          result.message || translate('auto.branchSwitch.failed', 'Could not switch branch.')
        )
      } finally {
        setIsSwitching(false)
      }
    },
    [gitContext, onSwitched, confirm]
  )

  const switchToCandidate = useCallback(
    async (candidate: BranchSwitchCandidate): Promise<void> => {
      // Why: git refuses to check out a branch held by another worktree; jump to
      // that workspace instead of attempting a switch that would error.
      if (candidate.checkedOutInWorktreeId) {
        setActiveWorktree(candidate.checkedOutInWorktreeId)
        return
      }
      if (candidate.isCurrent) { return }
      if (inFlightRef.current) { return }
      inFlightRef.current = true
      try {
        await runSwitch(candidate.branchName, 'plain')
      } finally {
        inFlightRef.current = false
      }
    },
    [runSwitch, setActiveWorktree]
  )

  const createBranch = useCallback(
    async (name: string): Promise<void> => {
      const trimmed = name.trim()
      if (!trimmed || trimmed.startsWith('-')) { return }
      if (inFlightRef.current) { return }
      inFlightRef.current = true
      try {
        await runSwitch(trimmed, 'create')
      } finally {
        inFlightRef.current = false
      }
    },
    [runSwitch]
  )

  return { query, setQuery, loading, candidates, isSwitching, switchToCandidate, createBranch }
}
