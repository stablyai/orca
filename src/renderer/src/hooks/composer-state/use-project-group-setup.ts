import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { GroupHookCheckResult } from '../../../../shared/project-group-hooks'
import type { SetupAgentStartupPolicy } from '../../../../shared/orca-yaml-hook-types'
import { getSetupConfig } from '../../../../shared/orca-hook-setup-config'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { useFolderSetupSupport } from '@/lib/workspace/creation/setup/folder-setup-support'
import { deriveWorkspaceSetupState } from '@/lib/workspace/creation/setup/workspace-setup-preparation'
import { checkRuntimeGroupHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { useAppStore } from '@/store'
import { buildSetupAgentStartupHookSettings } from './setup-policy-decisions'

export function useProjectGroupSetup(group: ProjectGroup | null | undefined) {
  const owner = group ? projectGroupHookOwner(group) : null
  const support = useFolderSetupSupport(owner, PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY)
  const context = owner?.id ?? null
  const [inspection, setInspection] = useState<{
    context: string
    result: GroupHookCheckResult
  } | null>(null)
  const [choice, setChoice] = useState<{ context: string; decision: 'run' | 'skip' | null } | null>(
    null
  )
  const groupId = group?.id
  const hostId = group ? getRepoExecutionHostId(group) : null
  useEffect(() => {
    if (!context || !groupId || !hostId || support !== 'supported') {
      return
    }
    let cancelled = false
    void checkRuntimeGroupHooks(hostId, groupId, { background: true })
      .then((result) => {
        if (!cancelled && !result.unavailable) {
          setInspection({ context, result })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context, groupId, hostId, support])
  const ready = inspection?.context === context
  const inspectedGroup =
    group && ready ? { ...group, hookSettings: inspection.result.hookSettings } : group
  const inspectedOwner = inspectedGroup ? projectGroupHookOwner(inspectedGroup) : null
  const config =
    inspectedOwner && support === 'supported'
      ? getSetupConfig(inspectedOwner, ready ? inspection.result.hooks : null)
      : null
  const decision = choice?.context === context ? choice.decision : null
  const derived = deriveWorkspaceSetupState(
    inspectedGroup ?? undefined,
    config,
    decision,
    support !== 'unsupported',
    support === 'pending' || !ready
  )
  const setDecision: Dispatch<SetStateAction<'run' | 'skip' | null>> = (next) => {
    if (context) {
      setChoice((current) => ({
        context,
        decision:
          typeof next === 'function'
            ? next(current?.context === context ? current.decision : null)
            : next
      }))
    }
  }
  return {
    ...derived,
    support,
    commitHooks: (result: GroupHookCheckResult) => {
      if (context) {
        setInspection({ context, result })
      }
    },
    decision,
    setDecision,
    startupPolicy: inspectedGroup?.hookSettings?.setupAgentStartupPolicy ?? 'start-immediately',
    setStartupPolicy: (policy: SetupAgentStartupPolicy) => {
      if (group && hostId) {
        const hookSettings = buildSetupAgentStartupHookSettings(
          inspectedGroup?.hookSettings,
          policy
        )
        setInspection((current) =>
          current?.context === context
            ? { ...current, result: { ...current.result, hookSettings } }
            : current
        )
        void useAppStore.getState().updateProjectGroup(group.id, { hookSettings }, { hostId })
      }
    }
  }
}
