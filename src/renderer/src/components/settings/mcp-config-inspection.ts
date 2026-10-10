import {
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES,
  selectExistingMcpConfigCandidates,
  type McpConfigDirectoryEntry
} from '../../../../shared/mcp-config'
import { joinPath } from '../../lib/path'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import type { LoadedMcpConfigInspection } from './McpConfigFileRow'
import {
  readRuntimeDirectory,
  readRuntimeFileContent,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

export async function loadMcpConfigInspections(
  targetRootPath: string,
  context: RuntimeFileOperationArgs
): Promise<LoadedMcpConfigInspection[]> {
  const entriesByRelativeDir = new Map<string, readonly McpConfigDirectoryEntry[]>()
  const rootEntries = await readRuntimeDirectory(context, targetRootPath)
  entriesByRelativeDir.set('', rootEntries)

  const rootDirectoryNames = new Set(
    rootEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
  )
  const unreadableParentDirMessages = new Map<string, string>()
  await Promise.all(
    getMcpConfigParentDirs().map(async (relativeDir) => {
      if (!rootDirectoryNames.has(relativeDir)) {
        return
      }
      try {
        const entries = await readRuntimeDirectory(context, joinPath(targetRootPath, relativeDir))
        entriesByRelativeDir.set(relativeDir, entries)
      } catch (error) {
        unreadableParentDirMessages.set(
          relativeDir,
          extractIpcErrorMessage(error, `Unable to inspect ${relativeDir}.`)
        )
      }
    })
  )

  const existingRelativePaths = new Set(
    selectExistingMcpConfigCandidates(entriesByRelativeDir).map(
      (candidate) => candidate.relativePath
    )
  )

  return Promise.all(
    MCP_CONFIG_CANDIDATES.map(async (candidate): Promise<LoadedMcpConfigInspection> => {
      const absolutePath = joinPath(targetRootPath, candidate.relativePath)
      const parentDirReadError = unreadableParentDirMessages.get(
        getMcpConfigCandidateParentDir(candidate)
      )
      if (parentDirReadError) {
        return {
          ...inspectMcpConfigContent(candidate, null),
          exists: false,
          status: 'invalid',
          absolutePath,
          readError: parentDirReadError
        }
      }

      if (!existingRelativePaths.has(candidate.relativePath)) {
        return { ...inspectMcpConfigContent(candidate, null), absolutePath }
      }

      try {
        const result = await readRuntimeFileContent({
          settings: context.settings,
          worktreeId: context.worktreeId ?? undefined,
          filePath: absolutePath,
          relativePath: candidate.relativePath,
          connectionId: context.connectionId
        })
        const inspection = inspectMcpConfigContent(candidate, result.isBinary ? '' : result.content)
        return { ...inspection, absolutePath }
      } catch (error) {
        if (isMissingFileError(error)) {
          return { ...inspectMcpConfigContent(candidate, null), absolutePath }
        }
        // Why: the listing proved the file exists; an unreadable file must not unlock starter overwrite.
        return {
          ...inspectMcpConfigContent(candidate, null),
          exists: true,
          status: 'invalid',
          absolutePath,
          readError: extractIpcErrorMessage(error, 'Unable to read config file.')
        }
      }
    })
  )
}
