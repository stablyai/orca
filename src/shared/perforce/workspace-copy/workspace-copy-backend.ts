import { createWorkspaceCopy } from './workspace-copy-create'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { listWorkspaceCopies } from './workspace-copy-list'
import { checkCopyReadiness } from './workspace-copy-readiness'
import { previewWorkspaceCopyRemoval } from './workspace-copy-removal-preview'
import { removeWorkspaceCopy } from './workspace-copy-remove'
import { listCopyStreams } from './workspace-copy-streams'
import type {
  PerforceStreamList,
  WorkspaceCopyCreateOptions,
  WorkspaceCopyCreateResult,
  WorkspaceCopyListResult,
  WorkspaceCopyProgress,
  WorkspaceCopyReadiness,
  WorkspaceCopyRemovalOptions,
  WorkspaceCopyRemovalPreview,
  WorkspaceCopyRemovalResult
} from './workspace-copy-types'

/** Copy operations, executed where the source workspace lives: this machine or an SSH relay. */
export type WorkspaceCopyBackend = {
  readiness: (cwd: string, minFreeBytes?: number) => Promise<WorkspaceCopyReadiness>
  list: (cwd: string) => Promise<WorkspaceCopyListResult>
  create: (
    cwd: string,
    options: WorkspaceCopyCreateOptions,
    onProgress?: (progress: WorkspaceCopyProgress) => void
  ) => Promise<WorkspaceCopyCreateResult>
  previewRemoval: (cwd: string, name: string) => Promise<WorkspaceCopyRemovalPreview>
  remove: (
    cwd: string,
    name: string,
    options: WorkspaceCopyRemovalOptions
  ) => Promise<WorkspaceCopyRemovalResult>
  streams: (cwd: string) => Promise<PerforceStreamList>
}

export function createLocalWorkspaceCopyBackend(host: WorkspaceCopyHost): WorkspaceCopyBackend {
  return {
    readiness: async (cwd, minFreeBytes) => {
      const { resolvedSource: _source, ...readiness } = await checkCopyReadiness(host, cwd, {
        minFreeBytes
      })
      return readiness
    },
    list: (cwd) => listWorkspaceCopies(host, cwd),
    create: (cwd, options, onProgress) => createWorkspaceCopy(host, cwd, options, onProgress),
    previewRemoval: (cwd, name) => previewWorkspaceCopyRemoval(host, cwd, name),
    remove: (cwd, name, options) => removeWorkspaceCopy(host, cwd, name, options),
    streams: (cwd) => listCopyStreams(host, cwd)
  }
}
