import { create } from 'zustand'
import { useAppStore } from '@/store'
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isPerforceRepo } from '../../../../shared/repo-kind'
import type {
  WorkspaceCopyIpcResult,
  WorkspaceCopyReadiness,
  WorkspaceCopyStreamChoice
} from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'

/**
 * A Perforce project's create choice: the stream to branch from, and whether a copy can be made
 * here (null until the host answers).
 */
export type PerforceCopyComposerChoice = {
  stream: WorkspaceCopyStreamChoice
  ready: boolean | null
}

type PerforceCopyComposerChoiceState = {
  /** Per Perforce project on its host, for this session; set once the composer shows that project. */
  byRepo: Record<string, PerforceCopyComposerChoice>
  setChoice: (key: string, patch: Partial<PerforceCopyComposerChoice>) => void
}

/** Keys a project's choice by its host too: one project id can be registered on several hosts. */
export function perforceCopyChoiceKey(repoId: string, hostId: string | null | undefined): string {
  return `${hostId ?? ''}|${repoId}`
}

export const usePerforceCopyComposerChoiceStore = create<PerforceCopyComposerChoiceState>()(
  (set) => ({
    byRepo: {},
    setChoice: (key, patch) =>
      set((state) => {
        const current: PerforceCopyComposerChoice | undefined = state.byRepo[key]
        return {
          byRepo: {
            ...state.byRepo,
            [key]: { ...(current ?? { stream: { kind: 'child' }, ready: null }), ...patch }
          }
        }
      })
  })
)

const readinessChecks = new Map<string, Promise<WorkspaceCopyIpcResult<WorkspaceCopyReadiness>>>()

/** Asks the project's host whether it can make a copy; the composer and a create share a check in flight. */
export function checkPerforceCopyReadiness(
  repoId: string,
  hostId: ExecutionHostId | null | undefined
): Promise<WorkspaceCopyIpcResult<WorkspaceCopyReadiness>> {
  const key = perforceCopyChoiceKey(repoId, hostId)
  const inFlight = readinessChecks.get(key)
  if (inFlight) {
    return inFlight
  }
  const check = runPerforceCopyOperation(
    perforceProjectTarget(repoId, hostId ?? null),
    'copyReadiness',
    {}
  )
    .then((result) => {
      usePerforceCopyComposerChoiceStore
        .getState()
        .setChoice(key, { ready: result.ok && result.value.ready })
      return result
    })
    .finally(() => readinessChecks.delete(key))
  readinessChecks.set(key, check)
  return check
}

/**
 * The copy to make for a create in `repoId`: a Perforce project's workspaces are copies, as Git
 * projects' are worktrees. Undefined for other projects, and when the host cannot make a copy (the
 * workspace then shares the project folder, which the composer says).
 */
export async function resolvePerforceCopyComposerChoice(
  repoId: string,
  hostId?: ExecutionHostId | null
): Promise<{ stream: WorkspaceCopyStreamChoice } | undefined> {
  const state = useAppStore.getState()
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (!repo || !isPerforceRepo(repo)) {
    return undefined
  }
  const key = perforceCopyChoiceKey(repoId, hostId)
  // Why: a create submitted before the host answered waits for it, so a host that cannot copy gets
  // a shared-folder workspace instead of a create that fails.
  if ((usePerforceCopyComposerChoiceStore.getState().byRepo[key]?.ready ?? null) === null) {
    await checkPerforceCopyReadiness(repoId, hostId)
  }
  const choice = usePerforceCopyComposerChoiceStore.getState().byRepo[key]
  return choice?.ready ? { stream: choice.stream } : undefined
}
