import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { eligibleThreadProjects, type ThreadProject } from './thread-projects'

export function useThreadProjects(): { projects: ThreadProject[]; loading: boolean } {
  const inputs = useAppStore(
    useShallow((state) => [
      state.repos,
      selectWorktreesByRepo(state),
      state.runtimeStatusByEnvironmentId
    ])
  )
  const [result, setResult] = useState<{ inputs: typeof inputs; projects: ThreadProject[] } | null>(
    null
  )
  useEffect(() => {
    let active = true
    void eligibleThreadProjects(useAppStore.getState()).then((projects) => {
      if (active) {
        setResult({ inputs, projects })
      }
    })
    return () => {
      active = false
    }
  }, [inputs])
  return { projects: result?.projects ?? [], loading: result?.inputs !== inputs }
}
