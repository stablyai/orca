import { useCallback, useMemo, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  CloneTargetArgs,
  CloneTargetCheck
} from '../../../../../../shared/git/clone/clone-target-check'

/** Shown only after the default clone folder turned out to be taken. */
export type CloneFolderOverride = {
  name: string
  taken: { folderName: string; reason: 'other-repository' | 'not-empty' }
}

async function checkCloneTargetOn(
  target: RuntimeClientTarget,
  args: CloneTargetArgs
): Promise<CloneTargetCheck | null> {
  try {
    return target.kind === 'environment'
      ? (await callRuntimeRpc<{ target: CloneTargetCheck }>(target, 'repo.checkCloneTarget', args))
          .target
      : await window.api.repos.checkCloneTarget(args)
  } catch {
    // Older hosts lack this check; the clone itself still refuses a taken folder.
    return null
  }
}

export function useCloneFolderOverride(
  url: string,
  destination: string
): {
  cloneFolder: CloneFolderOverride | null
  cloneArgs: CloneTargetArgs
  setCloneFolderName: (name: string) => void
  resetCloneFolder: () => void
  /** Resolves true, with the folder field shown, when the clone must not run as asked. */
  checkCloneFolderTaken: (
    target: RuntimeClientTarget | null,
    isCurrent?: () => boolean
  ) => Promise<boolean>
} {
  const [state, setState] = useState<
    (CloneFolderOverride & { url: string; destination: string }) | null
  >(null)
  const trimmedUrl = url.trim()
  const trimmedDestination = destination.trim()
  // A different URL or parent folder makes the suggested name stale.
  const cloneFolder =
    state?.url === trimmedUrl && state.destination === trimmedDestination ? state : null
  const folderName = cloneFolder?.name.trim()
  const cloneArgs = useMemo<CloneTargetArgs>(
    () => ({
      url: trimmedUrl,
      destination: trimmedDestination,
      ...(folderName ? { folderName } : {})
    }),
    [trimmedUrl, trimmedDestination, folderName]
  )

  const setCloneFolderName = useCallback((name: string): void => {
    setState((current) => (current ? { ...current, name } : current))
  }, [])
  const resetCloneFolder = useCallback((): void => setState(null), [])

  const checkCloneFolderTaken = useCallback(
    async (
      target: RuntimeClientTarget | null,
      isCurrent: () => boolean = () => true
    ): Promise<boolean> => {
      const check = target ? await checkCloneTargetOn(target, cloneArgs) : null
      if (!isCurrent()) {
        return true
      }
      if (check?.status !== 'taken') {
        return false
      }
      setState({
        url: cloneArgs.url,
        destination: cloneArgs.destination,
        name: check.suggestedFolderName ?? check.folderName,
        taken: { folderName: check.folderName, reason: check.reason }
      })
      return true
    },
    [cloneArgs]
  )

  return { cloneFolder, cloneArgs, setCloneFolderName, resetCloneFolder, checkCloneFolderTaken }
}
