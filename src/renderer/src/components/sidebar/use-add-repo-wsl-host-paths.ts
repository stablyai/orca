import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getWindowsPathAccess } from '@/lib/windows-path-access'
import { browseRuntimeServerDirectory } from '@/runtime/runtime-server-directory-browser'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { pickWslHostFolder, type DroppedHostPath } from './add-repo-wsl-host-folder-picker'

/**
 * Windows-side ways into a WSL host's distro for Add Project (D5): a `\\wsl.localhost` folder
 * dropped on the sidebar, and Windows' folder picker. Both land on the host-path step, filled in.
 */
export function useAddRepoWslHostPaths({
  isOpen,
  droppedHostPath,
  selectedHostId,
  setServerPath,
  setStep
}: {
  isOpen: boolean
  droppedHostPath: DroppedHostPath | null
  selectedHostId: ExecutionHostId | null
  setServerPath: (path: string) => void
  setStep: (step: AddRepoDialogStep) => void
}): {
  browseWslHost: (() => void) | null
  /** The last path Windows handed over; only that path skips the host's own browser. */
  prefilledServerPath: string | null
  clearPrefilledServerPath: () => void
} {
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  // Why a ref: every write is paired with setServerPath or setStep, which re-render the dialog.
  const prefilledServerPathRef = useRef<string | null>(null)
  const clearPrefilledServerPath = useCallback(() => {
    prefilledServerPathRef.current = null
  }, [])
  const setPickedServerPath = useCallback(
    (path: string) => {
      prefilledServerPathRef.current = path
      setServerPath(path)
    },
    [setServerPath]
  )
  const access = useMemo(
    () => getWindowsPathAccess(selectedHostId, runtimeEnvironments),
    [runtimeEnvironments, selectedHostId]
  )
  const pickerOwnerRef = useRef<ExecutionHostId | null>(null)
  useEffect(() => {
    pickerOwnerRef.current = isOpen ? selectedHostId : null
  }, [isOpen, selectedHostId])
  const handledDropRef = useRef<DroppedHostPath | null>(null)

  // Why an effect: the drop arrives through modal data, and the dropped host may only become
  // selectable after the dialog opens (its server still coming up). Runs once per drop.
  useEffect(() => {
    if (!isOpen) {
      handledDropRef.current = null
      return
    }
    if (
      !droppedHostPath ||
      handledDropRef.current === droppedHostPath ||
      selectedHostId !== droppedHostPath.hostId
    ) {
      return
    }
    handledDropRef.current = droppedHostPath
    setPickedServerPath(droppedHostPath.path)
    setStep('server-path')
  }, [droppedHostPath, isOpen, selectedHostId, setPickedServerPath, setStep])

  const browseWslHost = useCallback(async (): Promise<void> => {
    const host = parseExecutionHostId(selectedHostId)
    if (!access || host?.kind !== 'runtime') {
      return
    }
    const linuxPath = await pickWslHostFolder(access, {
      readHome: async () =>
        (await browseRuntimeServerDirectory(host.environmentId, '~')).resolvedPath,
      pickDirectory: (args) => window.api.shell.pickDirectory(args)
    })
    // Why: the dialog may have closed or switched hosts while Windows' picker was up.
    if (!linuxPath || pickerOwnerRef.current !== selectedHostId) {
      return
    }
    setPickedServerPath(linuxPath)
    setStep('server-path')
  }, [access, selectedHostId, setPickedServerPath, setStep])

  return {
    browseWslHost: access ? () => void browseWslHost() : null,
    prefilledServerPath: prefilledServerPathRef.current,
    clearPrefilledServerPath
  }
}
