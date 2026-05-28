import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileCode2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Repo, Worktree } from '../../../../shared/types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import {
  canInspectLocalMcpConfigRoot,
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG,
  selectExistingMcpConfigCandidates,
  type McpConfigDirectoryEntry
} from '../../../../shared/mcp-config'
import { useAppStore } from '../../store'
import { joinPath } from '../../lib/path'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { Button } from '../ui/button'
import { isWindowsUserAgent } from '../terminal-pane/pane-helpers'
import { McpConfigFileRow, type LoadedMcpConfigInspection } from './McpConfigFileRow'

type McpConfigSectionProps = {
  repo: Repo
}

const EMPTY_WORKTREES: Worktree[] = []

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

function countServers(configs: LoadedMcpConfigInspection[]): number {
  return configs.reduce((sum, config) => sum + config.servers.length, 0)
}

export function McpConfigSection({ repo }: McpConfigSectionProps): React.JSX.Element {
  const openFile = useAppStore((state) => state.openFile)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const ensureWorktreeRootGroup = useAppStore((state) => state.ensureWorktreeRootGroup)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const worktreesForRepo = useAppStore((state) => state.worktreesByRepo[repo.id] ?? EMPTY_WORKTREES)
  const sshConnectionStatus = useAppStore((state) =>
    repo.connectionId ? state.sshConnectionStates.get(repo.connectionId)?.status : null
  )
  const [configs, setConfigs] = useState<LoadedMcpConfigInspection[]>([])
  const [loading, setLoading] = useState(true)
  const [createConfirm, setCreateConfirm] = useState(false)
  const [inspectionUnavailableMessage, setInspectionUnavailableMessage] = useState<string | null>(
    null
  )

  const connectionId = repo.connectionId ?? undefined
  const isWindows = isWindowsUserAgent()
  const targetWorktree = useMemo(() => {
    if (activeWorktreeId && getRepoIdFromWorktreeId(activeWorktreeId) === repo.id) {
      return (
        worktreesForRepo.find((worktree) => worktree.id === activeWorktreeId) ?? {
          id: activeWorktreeId,
          path: repo.path
        }
      )
    }
    return (
      worktreesForRepo.find((worktree) => worktree.isMainWorktree) ??
      worktreesForRepo.find((worktree) => worktree.path === repo.path) ??
      worktreesForRepo[0] ?? { id: `${repo.id}::${repo.path}`, path: repo.path }
    )
  }, [activeWorktreeId, repo.id, repo.path, worktreesForRepo])
  const targetWorktreeId = targetWorktree.id
  const targetRootPath = targetWorktree.path
  const detectedCount = useMemo(() => configs.filter((config) => config.exists).length, [configs])
  const inspectionUnavailable = inspectionUnavailableMessage !== null
  const visibleConfigs = useMemo(
    () =>
      inspectionUnavailable
        ? []
        : configs.filter(
            (config) => config.exists || config.status === 'invalid' || config.readError
          ),
    [configs, inspectionUnavailable]
  )
  const missingConfigs = useMemo(
    () =>
      configs.filter(
        (config) => !config.exists && config.status === 'missing' && !config.readError
      ),
    [configs]
  )
  const missingInspections = useMemo(
    () =>
      MCP_CONFIG_CANDIDATES.map(
        (candidate): LoadedMcpConfigInspection => ({
          ...inspectMcpConfigContent(candidate, null),
          absolutePath: joinPath(targetRootPath, candidate.relativePath)
        })
      ),
    [targetRootPath]
  )
  const serverCount = useMemo(() => countServers(configs), [configs])
  const canCreateStarter = detectedCount === 0 && !inspectionUnavailable

  const loadConfigs = useCallback(async (): Promise<void> => {
    setLoading(true)
    setInspectionUnavailableMessage(null)

    try {
      if (connectionId && sshConnectionStatus !== 'connected') {
        setConfigs(missingInspections)
        setInspectionUnavailableMessage('Connect this SSH repo to inspect or add MCP configs.')
        return
      }

      if (!connectionId && !canInspectLocalMcpConfigRoot(targetRootPath, isWindows)) {
        setConfigs(missingInspections)
        setInspectionUnavailableMessage('This workspace path is not available from this host.')
        return
      }

      if (!connectionId && !(await window.api.shell.pathExists(targetRootPath))) {
        setConfigs(missingInspections)
        setInspectionUnavailableMessage('This workspace path is not available on disk.')
        return
      }

      const entriesByRelativeDir = new Map<string, readonly McpConfigDirectoryEntry[]>()
      const rootEntries = await window.api.fs.readDir({ dirPath: targetRootPath, connectionId })
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
            const entries = await window.api.fs.readDir({
              dirPath: joinPath(targetRootPath, relativeDir),
              connectionId
            })
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

      const next = await Promise.all(
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
            const result = await window.api.fs.readFile({ filePath: absolutePath, connectionId })
            const inspection = inspectMcpConfigContent(
              candidate,
              result.isBinary ? '' : result.content
            )
            return { ...inspection, absolutePath }
          } catch (error) {
            if (isMissingFileError(error)) {
              return { ...inspectMcpConfigContent(candidate, null), absolutePath }
            }
            return {
              ...inspectMcpConfigContent(candidate, null),
              exists: false,
              status: 'invalid',
              absolutePath,
              readError: extractIpcErrorMessage(error, 'Unable to read config file.')
            }
          }
        })
      )
      setConfigs(next)
    } catch (error) {
      setConfigs(missingInspections)
      setInspectionUnavailableMessage(
        extractIpcErrorMessage(error, 'Unable to inspect MCP configs.')
      )
    } finally {
      setLoading(false)
    }
  }, [connectionId, isWindows, missingInspections, sshConnectionStatus, targetRootPath])

  useEffect(() => {
    void loadConfigs()
  }, [loadConfigs])

  const handleOpen = (config: LoadedMcpConfigInspection): void => {
    setActiveWorktree(targetWorktreeId)
    const targetGroupId = ensureWorktreeRootGroup(targetWorktreeId)
    openFile(
      {
        filePath: config.absolutePath,
        relativePath: config.candidate.relativePath,
        worktreeId: targetWorktreeId,
        language: 'json',
        mode: 'edit'
      },
      { targetGroupId }
    )
    setActiveView('terminal')
  }

  const handleCreateStarter = async (): Promise<void> => {
    if (!createConfirm) {
      setCreateConfirm(true)
      window.setTimeout(() => setCreateConfirm(false), 3000)
      return
    }

    const target = joinPath(targetRootPath, '.mcp.json')
    try {
      // Why: v1 only creates the root workspace config so we do not need to
      // guess per-agent directory layouts or mutate agent-specific files.
      await window.api.fs.writeFile({ filePath: target, content: MCP_STARTER_CONFIG, connectionId })
      setCreateConfirm(false)
      await loadConfigs()
      setActiveWorktree(targetWorktreeId)
      const targetGroupId = ensureWorktreeRootGroup(targetWorktreeId)
      openFile(
        {
          filePath: target,
          relativePath: '.mcp.json',
          worktreeId: targetWorktreeId,
          language: 'json',
          mode: 'edit'
        },
        { targetGroupId }
      )
      setActiveView('terminal')
      toast.success('MCP config created', { description: '.mcp.json' })
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to create MCP config.'))
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">MCP Configs</h3>
          <p className="text-xs text-muted-foreground">
            Inspect MCP server definitions that agents can use while working in this repo.
          </p>
          {repo.connectionId ? (
            <p className="text-xs text-muted-foreground">
              SSH repos are read through the remote filesystem. Starter creation is limited to the
              workspace root config.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadConfigs()}
            aria-label="Refresh MCP configs"
          >
            {loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
          {canCreateStarter ? (
            <Button
              variant={createConfirm ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => void handleCreateStarter()}
            >
              <Plus className="size-3.5" />
              {createConfirm ? 'Create empty config' : 'Add MCP config'}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="rounded-md border border-border/50 bg-muted/20">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {detectedCount} detected · {serverCount} server{serverCount === 1 ? '' : 's'}
          </span>
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
        </div>
        <div>
          {visibleConfigs.length === 0 ? (
            <div className="flex items-start gap-2 px-3 py-2.5 text-xs text-muted-foreground">
              {inspectionUnavailable ? (
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <FileCode2 className="mt-0.5 size-3.5 shrink-0" />
              )}
              {inspectionUnavailable ? (
                <span>{inspectionUnavailableMessage}</span>
              ) : (
                <span>
                  No MCP config found. Add an empty workspace config when you want this repo to
                  define its own MCP servers.
                </span>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {visibleConfigs.map((config) => (
                <McpConfigFileRow
                  key={config.candidate.relativePath}
                  config={config}
                  onOpen={handleOpen}
                />
              ))}
            </div>
          )}

          {missingConfigs.length > 0 && !inspectionUnavailable ? (
            <div className="space-y-1.5 border-t border-border/50 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">Checked</p>
              <div className="flex flex-wrap gap-1.5">
                {missingConfigs.map((config) => (
                  <span
                    key={config.candidate.relativePath}
                    className="rounded-md border border-border/50 bg-background/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {config.candidate.relativePath}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
