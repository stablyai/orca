import { useCallback, useState } from 'react'
import type { ParsedExecutionHost } from '../../../../shared/execution-host'
import { routeAddRepoBrowse } from './add-repo-browse-authority'

export function useAddRepoBrowseRouting(
  selectedHost: ParsedExecutionHost | null,
  local: { browse: () => void; group: () => void },
  ssh: { browse: (targetId: string) => void; group: (targetId: string) => void },
  openRuntimePath: () => void
): {
  groupServerRepositories: boolean
  handleBrowse: () => void
  handleGroupRepositories: () => void
  resetGroupBrowseRouting: () => void
} {
  const [groupServerRepositories, setGroupServerRepositories] = useState(false)
  const handleBrowse = useCallback(() => {
    routeAddRepoBrowse(selectedHost, {
      browseLocal: local.browse,
      browseRuntime: () => {
        setGroupServerRepositories(false)
        openRuntimePath()
      },
      browseSsh: ssh.browse
    })
  }, [local.browse, openRuntimePath, selectedHost, ssh.browse])
  const handleGroupRepositories = useCallback(() => {
    routeAddRepoBrowse(selectedHost, {
      browseLocal: local.group,
      browseRuntime: () => {
        setGroupServerRepositories(true)
        openRuntimePath()
      },
      browseSsh: ssh.group
    })
  }, [local.group, openRuntimePath, selectedHost, ssh.group])
  const resetGroupBrowseRouting = useCallback(() => setGroupServerRepositories(false), [])

  return {
    groupServerRepositories,
    handleBrowse,
    handleGroupRepositories,
    resetGroupBrowseRouting
  }
}
