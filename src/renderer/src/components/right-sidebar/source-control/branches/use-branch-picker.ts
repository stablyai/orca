import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import {
  listRuntimeGitBranches,
  searchRuntimeRemoteBranches,
  switchRuntimeGitBranch,
  branchSwitchExistingBranch
} from '@/runtime/source-control/git/runtime-git-branch-client'
import type {
  RuntimeGitLocalBranches,
  RuntimeRepoSearchRefs
} from '../../../../../../shared/runtime-worktree-contracts'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  branchPickerRows,
  indexBranchWorkspaces,
  indexLocalBranchRows,
  type BranchWorkspace,
  type BranchPickerRow
} from './branch-picker-rows'

const EMPTY_LOCAL: RuntimeGitLocalBranches = { current: null, branches: [] }
export type BranchPickerOptions = {
  context: RuntimeGitContext
  repoId: string
  hostId: ExecutionHostId
  hostLabel: string
  /** Names the workspace in a result that arrives after the user moved on. */
  workspaceLabel: string
  workspaces: ReadonlyMap<string, BranchWorkspace>
  onOpenWorkspace: (workspace: BranchWorkspace) => void
  onSwitched: (warning?: string) => void
}
export function useBranchPicker(options: BranchPickerOptions) {
  const [open, updateOpen] = useState(false)
  const [openedAt, setOpenedAt] = useState(0)
  const setOpen = useCallback((next: boolean) => {
    if (next) {
      setOpenedAt(Date.now())
    }
    updateOpen(next)
  }, [])
  const [query, setQuery] = useState('')
  const [local, setLocal] = useState(EMPTY_LOCAL)
  const [remote, setRemote] = useState<{ query: string; page: RuntimeRepoSearchRefs } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const { context, repoId, hostId, workspaces } = options
  const { target, worktreeId, worktreePath } = context
  const route = useMemo(
    () => ({ target, worktreeId, worktreePath }),
    [target, worktreeId, worktreePath]
  )
  useEffect(() => {
    if (!open) {
      setLocal(EMPTY_LOCAL)
      setRemote(null)
      return
    }
    let stale = false
    setError(null)
    setQuery('')
    void listRuntimeGitBranches(route)
      .then((result) => {
        if (!stale) {
          setLocal(result)
        }
      })
      .catch(() => {
        if (!stale) {
          setError(
            translate(
              'sourceControl.branchPicker.listFailed',
              "Orca couldn't list local branches. Try reopening the picker."
            )
          )
        }
      })
    return () => {
      stale = true
    }
  }, [open, route])
  useEffect(() => {
    if (!open) {
      return
    }
    let stale = false
    setDiscoveryError(null)
    const timer = setTimeout(() => {
      void searchRuntimeRemoteBranches(route, repoId, query)
        .then((page) => {
          if (!stale) {
            setRemote({ query, page })
          }
        })
        .catch(() => {
          if (!stale) {
            setDiscoveryError(
              translate(
                'sourceControl.branchPicker.discoveryFailed',
                "Orca couldn't find remote branches. You can still switch local branches or create a branch."
              )
            )
          }
        })
    }, 200)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [open, query, repoId, route])
  useEffect(
    () => () => {
      generation.current += 1
    },
    [context.worktreeId, context.target]
  )
  const workspaceIndex = useMemo(
    () => indexBranchWorkspaces(open, workspaces.values(), repoId, hostId),
    [open, workspaces, repoId, hostId]
  )
  const localRows = useMemo(
    () => (open ? indexLocalBranchRows(local, context.worktreePath, workspaceIndex) : []),
    [open, local, context.worktreePath, workspaceIndex]
  )
  const localNames = useMemo(() => new Set(local.branches), [local])
  const currentRemote = remote?.query === query ? remote.page : null
  const rows = useMemo(
    () => branchPickerRows(localRows, localNames, currentRemote, query),
    [localRows, localNames, currentRemote, query]
  )
  const { onOpenWorkspace, onSwitched, hostLabel, workspaceLabel } = options
  const selectRef = useRef<(row: BranchPickerRow) => Promise<void>>(async () => {})
  const select = useCallback(
    async (row: BranchPickerRow) => {
      if (row.workspace) {
        onOpenWorkspace(row.workspace)
        setOpen(false)
        return
      }
      if (row.current || row.occupiedPath || inFlight.current) {
        return
      }
      inFlight.current = true
      const ownGeneration = generation.current
      setPending(true)
      try {
        const result = await switchRuntimeGitBranch(route, row.target, hostLabel)
        onSwitched(result.warning)
        if (generation.current === ownGeneration) {
          setOpen(false)
        }
      } catch (failure) {
        // Report a failure even after the user left; only the recovery needs this picker.
        const here = generation.current === ownGeneration
        if (here) {
          setOpen(false)
        }
        const existingBranch = here ? branchSwitchExistingBranch(failure) : null
        toast.error(
          here
            ? translate('sourceControl.branchPicker.switchFailedTitle', "Couldn't switch branches")
            : translate(
                'sourceControl.branchPicker.switchFailedIn',
                "Couldn't switch branches in {{workspace}}",
                { workspace: workspaceLabel }
              ),
          {
            description:
              failure instanceof Error
                ? failure.message
                : translate(
                    'sourceControl.branchPicker.switchFailed',
                    "Orca couldn't switch branches. Try again."
                  ),
            // Matches the landed warning so the reason and its recovery stay readable.
            duration: 15000,
            action: existingBranch
              ? {
                  label: translate('sourceControl.branchPicker.recover', 'Switch to {{branch}}', {
                    branch: existingBranch
                  }),
                  onClick: () => {
                    // A toast outlives the picker; never switch a workspace the user has left.
                    if (generation.current === ownGeneration) {
                      void selectRef.current({
                        target: { kind: 'local', name: existingBranch },
                        label: existingBranch
                      })
                    }
                  }
                }
              : undefined
          }
        )
      }
      inFlight.current = false
      if (generation.current === ownGeneration) {
        setPending(false)
      }
    },
    [route, hostLabel, workspaceLabel, onOpenWorkspace, onSwitched, setOpen]
  )
  useEffect(() => {
    selectRef.current = select
  }, [select])
  return {
    open,
    openedAt,
    setOpen,
    query,
    setQuery,
    rows,
    error,
    discoveryError,
    pending,
    select
  }
}
