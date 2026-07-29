import { toast } from 'sonner'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { defaultProjectGroupNameForPath } from '@/components/sidebar/add-repo-dialog-types'
import { useAppStore } from '@/store'
import { detectLanguage } from './language-detect'
import { findLocalProjectGroupForFilePath } from './os-requested-file-project-group'
import { findWorkspaceForFilePath, type WorkspaceCandidate } from './os-requested-file-workspace'
import { basename, dirname } from './path'
import { activateAndRevealWorktree } from './worktree-activation'
import { translate } from '@/i18n/i18n'

function collectWorkspaceCandidates(): WorkspaceCandidate[] {
  const state = useAppStore.getState()
  const candidates: WorkspaceCandidate[] = []
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      candidates.push({ id: worktree.id, path: worktree.path })
    }
  }
  for (const folderWorkspace of state.folderWorkspaces) {
    candidates.push({
      id: folderWorkspaceToWorktree(folderWorkspace).id,
      path: folderWorkspace.folderPath
    })
  }
  return candidates
}

async function resolveProjectGroupId(filePath: string, folderPath: string): Promise<string | null> {
  const state = useAppStore.getState()
  // Why: a folder-backed group the user already made is a better home than a new one.
  const existing = findLocalProjectGroupForFilePath(filePath, state.projectGroups)
  if (existing) {
    return existing.id
  }
  // Why: the OS always hands over a local path, so the new group must not follow the active runtime.
  const created = await state.createProjectGroup(defaultProjectGroupNameForPath(folderPath), {
    runtimeEnvironmentId: null
  })
  return created?.id ?? null
}

// Why: concurrent calls must not both miss the same not-yet-created workspace and each create a duplicate.
let openOsRequestedFileChain: Promise<void> = Promise.resolve()

export function openOsRequestedFile(filePath: string): Promise<void> {
  const run = openOsRequestedFileChain.then(() => openOsRequestedFileSerially(filePath))
  // Why: swallow so a rejected call doesn't wedge the chain for callers queued after it.
  openOsRequestedFileChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function openOsRequestedFileSerially(filePath: string): Promise<void> {
  const existing = findWorkspaceForFilePath(filePath, collectWorkspaceCandidates())
  let worktreeId = existing?.workspace.id ?? null
  // Why: an empty relative path means the match was the workspace root itself, not a file in it.
  let relativePath = existing?.relativePath ?? ''

  if (!worktreeId || !relativePath) {
    const folderPath = dirname(filePath)
    const projectGroupId = await resolveProjectGroupId(filePath, folderPath)
    if (!projectGroupId) {
      toast.error(
        translate(
          'auto.lib.open.os.requested.file.8086cba22b',
          'Could not open the file: no project group was available for its folder.'
        )
      )
      return
    }
    let created
    try {
      // Why: the OS always hands over a local path, so the new workspace must not follow the active runtime.
      created = await useAppStore.getState().createFolderWorkspace(
        {
          projectGroupId,
          name: basename(folderPath),
          folderPath
        },
        { runtimeEnvironmentId: null }
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.lib.open.os.requested.file.96019938b5', 'Could not open the file.')
      )
      return
    }
    if (!created) {
      toast.error(
        translate(
          'auto.lib.open.os.requested.file.bdf34177f8',
          'Could not open the file: creating a workspace for its folder failed.'
        )
      )
      return
    }
    worktreeId = folderWorkspaceToWorktree(created).id
    relativePath = basename(filePath)
  }

  activateAndRevealWorktree(worktreeId)
  useAppStore.getState().openFile(
    {
      filePath,
      relativePath,
      worktreeId,
      language: detectLanguage(filePath),
      mode: 'edit',
      // Why: the OS always hands over a local path, so never inherit a remote active runtime.
      runtimeEnvironmentId: null
    },
    { focusEditor: true }
  )
}
