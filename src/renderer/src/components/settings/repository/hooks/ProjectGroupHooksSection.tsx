import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { GroupHookCheckResult } from '../../../../../../shared/project-group-hooks'
import { projectGroupHookOwner } from '../../../../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
} from '../../../../../../shared/worktree-runtime-capabilities'
import { getFolderSourceRepos } from '../../../../../../shared/folder-workspaces/folder-workspace-source-repos'
import { projectGroupSetupExample } from '../../../../../../shared/project-group-setup-example'
import { useFolderSetupSupport } from '@/lib/workspace/creation/setup/folder-setup-support'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useShallow } from 'zustand/react/shallow'
import { getFolderWorkspaceAgentLaunchFact } from '@/components/sidebar/workspace-creation/folder/folder-workspace-agent-startup'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { groupHookYamlPresentation } from './repository-hook-settings-draft'
import type {
  ProjectGroupHookSupport,
  ProjectGroupSettingsEntry
} from '@/hooks/use-supported-group-hook-settings'

export function ProjectGroupHooksSection({
  group
}: {
  group: ProjectGroupSettingsEntry
}): React.JSX.Element | null {
  return group.hookSupport ? (
    <GroupHooksEditor group={group} support={group.hookSupport} />
  ) : (
    <ObservedGroupHooksSection group={group} />
  )
}

function ObservedGroupHooksSection({ group }: { group: ProjectGroup }): React.JSX.Element | null {
  const owner = projectGroupHookOwner(group)
  const setup = useFolderSetupSupport(owner, PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY)
  const archive = useFolderSetupSupport(owner, PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY)
  return (
    <GroupHooksEditor
      group={group}
      support={{
        setup: setup === 'supported',
        archive: archive === 'supported',
        pending: setup === 'pending' || archive === 'pending'
      }}
    />
  )
}

function GroupHooksEditor({
  group,
  support
}: {
  group: ProjectGroup
  support: ProjectGroupHookSupport
}): React.JSX.Element | null {
  const t = useTranslate()
  const [inspection, setInspection] = useState<GroupHookCheckResult | null>(null)
  const confirmedInspection = useRef<GroupHookCheckResult | null>(null)
  const pendingSave = useRef<Promise<void> | null>(null)
  const [saving, setSaving] = useState(false)
  const fieldset = useRef<HTMLFieldSetElement>(null)
  const owner = projectGroupHookOwner(
    inspection ? { ...group, hookSettings: inspection.hookSettings } : group
  )
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
  const canInspect = support.setup && (!support.pending || inspection !== null)
  useEffect(() => {
    if (!canInspect) {
      return
    }
    let cancelled = false
    void checkRuntimeGroupHooks(hostId, group.id, { background: true })
      .then((result) => {
        if (!cancelled) {
          confirmedInspection.current = result
          setInspection(result)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [hostId, group.id, canInspect])
  if (!owner || !support.setup) {
    return null
  }
  const example = platform
    ? projectGroupSetupExample(getFolderSourceRepos(repos, groups, group), platform)
    : undefined
  const updateHookSettings = (hookSettings: NonNullable<ProjectGroup['hookSettings']>): void => {
    if (!inspection || inspection.unavailable || inspection.status === 'error') {
      return
    }
    if (fieldset.current) {
      setInspection({ ...inspection, hookSettings })
      setSaving(true)
    }
    // A blur/autosave may already be accepted before the pending fieldset renders.
    const save: Promise<void> = (pendingSave.current ?? Promise.resolve()).then(async () => {
      const previous = confirmedInspection.current
      if (!previous) {
        return
      }
      const ownsInspection = (): boolean =>
        Boolean(fieldset.current) && pendingSave.current === save
      let saved = false
      try {
        saved = await useAppStore
          .getState()
          .updateProjectGroup(group.id, { hookSettings }, { hostId })
      } catch {
        // A rejected endpoint reply still needs the same owner reconciliation as false.
      }
      if (saved) {
        confirmedInspection.current = { ...previous, hookSettings, status: 'ok' }
      } else {
        confirmedInspection.current = previous
        if (ownsInspection()) {
          setInspection({ ...previous })
        }
        if (fieldset.current) {
          try {
            const current = await checkRuntimeGroupHooks(hostId, group.id, { background: true })
            confirmedInspection.current =
              current.status !== 'error' && !current.unavailable
                ? current
                : { ...previous, status: 'error' }
          } catch {
            confirmedInspection.current = { ...previous, status: 'error' }
          }
        }
        toast.error(t('sessionHistory.settings.saveError', 'Could not save. Try again.'))
      }
      if (ownsInspection()) {
        setInspection(confirmedInspection.current)
      }
    })
    pendingSave.current = save
    void save.finally(() => {
      if (pendingSave.current === save) {
        pendingSave.current = null
        if (fieldset.current) {
          setSaving(false)
        }
      }
    })
  }
  const yamlPresentation = groupHookYamlPresentation(support.archive)
  const inspectionReady =
    inspection !== null && !inspection.unavailable && inspection.status !== 'error'
  return (
    <fieldset
      ref={fieldset}
      disabled={support.pending || !inspectionReady || saving}
      className="min-w-0"
    >
      <RepositoryHooksSection
        repo={owner}
        showArchive={yamlPresentation.archive}
        yamlPresentation={yamlPresentation}
        yamlHooks={inspection?.hooks ?? null}
        hasHooksFile={inspection?.hasHooks ?? false}
        hooksInspectionReady={inspectionReady}
        mayNeedUpdate={inspection?.mayNeedUpdate ?? false}
        copiedTemplate={false}
        onCopyTemplate={() => void window.api.ui.writeClipboardText(yamlPresentation.template)}
        setupExample={example}
        onUpdateHookSettings={updateHookSettings}
      />
    </fieldset>
  )
}
