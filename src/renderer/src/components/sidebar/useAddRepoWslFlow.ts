import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'

export function useAddRepoWslFlow({
  closeModal,
  fetchWorktrees,
  onGitRepoReady,
  setAddProjectBusyLabel
}: {
  closeModal: () => void
  fetchWorktrees: (repoId: string, options?: { requireAuthoritative?: boolean }) => Promise<unknown>
  onGitRepoReady: (repoId: string, source: AddRepoExistingWorkspaceSource) => Promise<void>
  setAddProjectBusyLabel: (label: string | null) => void
}): {
  wslDistro: string
  wslPath: string
  wslError: string | null
  isAddingWsl: boolean
  setWslDistro: Dispatch<SetStateAction<string>>
  setWslPath: Dispatch<SetStateAction<string>>
  resetWslFlow: () => void
  handleAddWsl: (kind: 'git' | 'folder') => Promise<void>
} {
  const [wslDistro, setWslDistro] = useState('')
  const [wslPath, setWslPath] = useState('')
  const [wslError, setWslError] = useState<string | null>(null)
  const [isAddingWsl, setIsAddingWsl] = useState(false)
  const wslAddGenRef = useRef(0)

  const resetWslFlow = useCallback((): void => {
    wslAddGenRef.current++
    setWslDistro('')
    setWslPath('')
    setWslError(null)
    setIsAddingWsl(false)
  }, [])

  const handleAddWsl = useCallback(
    async (kind: 'git' | 'folder'): Promise<void> => {
      const distro = wslDistro.trim()
      const linuxPath = wslPath.trim()
      if (!distro || !linuxPath) {
        return
      }
      const gen = ++wslAddGenRef.current
      setIsAddingWsl(true)
      setWslError(null)
      setAddProjectBusyLabel(kind === 'git' ? 'Opening project...' : 'Opening folder...')
      try {
        const result = await window.api.repos.add({ wsl: { distro, linuxPath }, kind })
        if (gen !== wslAddGenRef.current) {
          return
        }
        if ('error' in result) {
          setWslError(result.error)
          return
        }
        const repo = result.repo
        if (isGitRepoKind(repo)) {
          // Why: once the repo exists, a transient non-authoritative refresh
          // should fall through to project reveal instead of leaving the add flow open.
          await fetchWorktrees(repo.id, { requireAuthoritative: true })
          if (gen !== wslAddGenRef.current) {
            return
          }
          await onGitRepoReady(repo.id, 'wsl_path')
        } else {
          // Why: folder repos skip the Git default-checkout handoff; their synthetic
          // root workspace is opened by the folder add flow.
          await markOnboardingProjectAdded('addedFolder')
          closeModal()
        }
      } finally {
        if (gen === wslAddGenRef.current) {
          setIsAddingWsl(false)
          setAddProjectBusyLabel(null)
        }
      }
    },
    [closeModal, fetchWorktrees, onGitRepoReady, setAddProjectBusyLabel, wslDistro, wslPath]
  )

  return {
    wslDistro,
    wslPath,
    wslError,
    isAddingWsl,
    setWslDistro,
    setWslPath,
    resetWslFlow,
    handleAddWsl
  }
}
