import { useAppStore } from '../index'
import { useShallow } from 'zustand/react/shallow'
import { getIndexedRepoMap as getCachedRepoMap } from './repository-catalog-index'
import { selectRepoByIdForActiveWorkspace } from './active-workspace-repository'

export const useRepos = () => useAppStore((s) => s.repos)

export const useActiveRepo = () =>
  useAppStore(useShallow((s) => selectRepoByIdForActiveWorkspace(s, s.activeRepoId)))

export const useRepoMap = () => useAppStore((s) => getCachedRepoMap(s.repos))

export const useRepoById = (repoId: string | null) =>
  useAppStore((s) => selectRepoByIdForActiveWorkspace(s, repoId))
