import { useEffect, useState } from 'react'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { GroupHookCheckResult } from '../../../../../../shared/project-group-hooks'
import { projectGroupHookOwner } from '../../../../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { getFolderSourceRepos } from '../../../../../../shared/folder-workspaces/folder-workspace-source-repos'
import { projectGroupSetupExample } from '../../../../../../shared/project-group-setup-example'
import { useFolderSetupSupport } from '@/lib/workspace/creation/setup/folder-setup-support'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { getFolderWorkspaceAgentLaunchFact } from '@/components/sidebar/workspace-creation/folder/folder-workspace-agent-startup'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { GROUP_SETUP_HOOKS_TEMPLATE } from './repository-hook-settings-draft'

export function ProjectGroupHooksSection({
  group
}: {
  group: ProjectGroup
}): React.JSX.Element | null {
  const [inspection, setInspection] = useState<GroupHookCheckResult | null>(null)
  const owner = projectGroupHookOwner(
    inspection ? { ...group, hookSettings: inspection.hookSettings } : group
  )
  const support = useFolderSetupSupport(owner, PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY)
  const [repos, groups, platform] = useAppStore(
    useShallow((state) => {
      const facts = getFolderWorkspaceAgentLaunchFact(state, group)
      return [
        state.repos,
        state.projectGroups,
        facts.kind === 'known' ? facts.platform : null
      ] as const
    })
  )
  const hostId = getRepoExecutionHostId(group)
  useEffect(() => {
    if (support !== 'supported') {
      return
    }
    let cancelled = false
    void checkRuntimeGroupHooks(hostId, group.id, { background: true })
      .then((result) => {
        if (!cancelled) {
          setInspection(result)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hostId, group.id, support])
  if (!owner || support !== 'supported') {
    return null
  }
  const example = platform
    ? projectGroupSetupExample(getFolderSourceRepos(repos, groups, group), platform)
    : undefined
  return (
    <RepositoryHooksSection
      repo={owner}
      showArchive={false}
      yamlHooks={inspection?.hooks ?? null}
      hasHooksFile={inspection?.hasHooks ?? false}
      hooksInspectionReady={inspection !== null && !inspection.unavailable}
      mayNeedUpdate={inspection?.mayNeedUpdate ?? false}
      copiedTemplate={false}
      onCopyTemplate={() => void window.api.ui.writeClipboardText(GROUP_SETUP_HOOKS_TEMPLATE)}
      setupExample={example}
      onUpdateHookSettings={(hookSettings) => {
        setInspection((current) => (current ? { ...current, hookSettings } : current))
        void useAppStore.getState().updateProjectGroup(group.id, { hookSettings }, { hostId })
      }}
    />
  )
}
