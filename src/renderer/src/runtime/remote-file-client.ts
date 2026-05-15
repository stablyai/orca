import type { GlobalSettings } from '../../../shared/types'
import { readRuntimeFileContent, type RuntimeReadableFileContent } from './runtime-file-client'

export type RemoteReadableFile = {
  worktreeId: string
  relativePath: string
  filePath?: string
}

export type RemoteFileContent = RuntimeReadableFileContent

export async function readFileFromActiveRuntime(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  file: RemoteReadableFile
): Promise<RemoteFileContent> {
  return readRuntimeFileContent({
    settings,
    filePath: file.filePath ?? file.relativePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId
  })
}
