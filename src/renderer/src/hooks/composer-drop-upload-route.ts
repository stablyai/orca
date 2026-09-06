import { parseExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { shouldUploadRemoteEditorFileDrop } from './useGlobalFileDrop'

export type ComposerDropUploadTarget = {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  connectionId?: string | null
  repo?: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null
  executionHostId?: string | null
}

export function resolveComposerDropUploadSettings(
  target: ComposerDropUploadTarget
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  const repoSettings = target.repo
    ? getSettingsForRepoRuntimeOwner(
        { repos: [target.repo], settings: target.settings },
        target.repo.id
      )
    : target.settings
  const parsedHost = parseExecutionHostId(target.executionHostId)
  // Why: a paired runtime worktree can own the drop via `runtime:*` even when
  // global focus and SSH connectionId are both unset (#16558).
  if (parsedHost?.kind === 'runtime') {
    return {
      ...repoSettings,
      activeRuntimeEnvironmentId: parsedHost.environmentId
    }
  }
  if (parsedHost?.kind === 'local') {
    return {
      ...repoSettings,
      activeRuntimeEnvironmentId: null
    }
  }
  return repoSettings
}

export function shouldUploadComposerDropPaths(target: ComposerDropUploadTarget): boolean {
  return shouldUploadRemoteEditorFileDrop(
    resolveComposerDropUploadSettings(target),
    target.connectionId
  )
}
