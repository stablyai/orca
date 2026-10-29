import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { persistedUIValuesEqual } from '../../../../../../shared/persisted-ui-equality'
import { getProjectHeaderHostContexts } from '../rows/project-header-host-context'

type ContextArgs = Omit<
  Parameters<typeof getProjectHeaderHostContexts>[0],
  'runtimeEnvironments' | 'sshConnectionStates'
>

function createProjectHeaderHostContextsSelector(args: ContextArgs) {
  let inputs: readonly unknown[] = []
  let result: ReturnType<typeof getProjectHeaderHostContexts> = new Map()
  return (state: AppState) => {
    const nextInputs = [state.runtimeEnvironments, state.sshConnectionStates]
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = getProjectHeaderHostContexts({
      ...args,
      runtimeEnvironments: state.runtimeEnvironments,
      sshConnectionStates: state.sshConnectionStates
    })
    if (!persistedUIValuesEqual([...result], [...next])) {
      result = next
    }
    return result
  }
}

export function useProjectHeaderHostContexts(args: ContextArgs) {
  const { rows, visibleProjectRepoIdsBySection, hosts, repoMap, projectGrouping } = args
  const select = useMemo(
    () =>
      createProjectHeaderHostContextsSelector({
        rows,
        visibleProjectRepoIdsBySection,
        hosts,
        repoMap,
        projectGrouping
      }),
    [rows, visibleProjectRepoIdsBySection, hosts, repoMap, projectGrouping]
  )
  return useAppStore(select)
}
