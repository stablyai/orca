import { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'

export type ProjectKindChoice = 'git' | 'folder'

/** 'git' continues the normal Git add; otherwise the add already finished or was dismissed. */
export type ChooseProjectKind = (
  path: string
) => Promise<'git' | { status: 'completed'; repo: Repo } | { status: 'paused' }>

export type ProjectKindChoiceState = {
  pendingPath: string | null
  /** Undefined when the setting is off, so callers keep auto-detecting. */
  chooseProjectKind: ChooseProjectKind | undefined
  resolveProjectKind: (choice: ProjectKindChoice | null) => void
}

export function useProjectKindChoice(closeModal: () => void): ProjectKindChoiceState {
  const askProjectKindOnAdd = useAppStore((s) => s.settings?.askProjectKindOnAdd ?? false)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const resolverRef = useRef<((choice: ProjectKindChoice | null) => void) | null>(null)

  const resolveProjectKind = useCallback((choice: ProjectKindChoice | null): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPendingPath(null)
    resolve?.(choice)
  }, [])

  const chooseProjectKind = useCallback<ChooseProjectKind>(
    async (path) => {
      // Why: a newer request supersedes an unanswered one, which reads as a cancel.
      resolveProjectKind(null)
      const choice = await new Promise<ProjectKindChoice | null>((resolve) => {
        resolverRef.current = resolve
        setPendingPath(path)
      })
      if (choice === 'git') {
        return 'git'
      }
      // Why: the local picker only runs without a runtime environment, so the folder lives on this machine.
      const repo = choice ? await addNonGitFolder(path, { runtimeEnvironmentId: null }) : null
      if (!repo) {
        return { status: 'paused' }
      }
      closeModal()
      return { status: 'completed', repo }
    },
    [addNonGitFolder, closeModal, resolveProjectKind]
  )

  return useMemo(
    () => ({
      pendingPath,
      chooseProjectKind: askProjectKindOnAdd ? chooseProjectKind : undefined,
      resolveProjectKind
    }),
    [askProjectKindOnAdd, chooseProjectKind, pendingPath, resolveProjectKind]
  )
}
