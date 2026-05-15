import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, FileCode2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Repo, Worktree } from '../../../../shared/types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import {
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG,
  type McpConfigInspection
} from '../../../../shared/mcp-config'
import { useAppStore } from '../../store'
import { joinPath } from '../../lib/path'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { Button } from '../ui/button'

type LoadedInspection = McpConfigInspection & {
  absolutePath: string
  readError?: string
}

type McpConfigSectionProps = {
  repo: Repo
}

const EMPTY_WORKTREES: Worktree[] = []

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

function isNoFilesystemProviderMessage(message: string | undefined): boolean {
  return message ? /no filesystem provider/i.test(message) : false
}

function countServers(configs: LoadedInspection[]): number {
  return configs.reduce((sum, config) => sum + config.servers.length, 0)
}

function statusLabel(config: LoadedInspection): string {
  if (config.readError) {
    return 'Unreadable'
  }
  if (config.status === 'missing') {
    return 'Not found'
  }
  if (config.status === 'invalid') {
    return 'Invalid JSON'
  }
  if (config.servers.length === 0) {
    return 'No servers'
  }
  return `${config.servers.length} server${config.servers.length === 1 ? '' : 's'}`
}

function statusClassName(config: LoadedInspection): string {
  if (config.readError || config.status === 'invalid') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (config.status === 'valid' && config.servers.length > 0) {
    return 'border-border/60 bg-background text-foreground'
  }
  return 'border-border/60 bg-muted/60 text-muted-foreground'
}

function serverDetailLabel(server: LoadedInspection['servers'][number]): string {
  if (server.transport === 'http') {
    return server.url ?? 'HTTP server'
  }
  if (server.transport === 'stdio') {
    return server.command ?? 'stdio server'
  }
  return server.issue ?? 'Invalid server'
}

export function McpConfigSection({ repo }: McpConfigSectionProps): React.JSX.Element {
  const openFile = useAppStore((state) => state.openFile)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const ensureWorktreeRootGroup = useAppStore((state) => state.ensureWorktreeRootGroup)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const worktreesForRepo = useAppStore((state) => state.worktreesByRepo[repo.id] ?? EMPTY_WORKTREES)
  const [configs, setConfigs] = useState<LoadedInspection[]>([])
  const [loading, setLoading] = useState(true)
  const [createConfirm, setCreateConfirm] = useState(false)

  const connectionId = repo.connectionId ?? undefined
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
  const remoteFilesystemUnavailable = useMemo(
    () =>
      Boolean(connectionId) &&
      configs.length > 0 &&
      configs.every((config) => isNoFilesystemProviderMessage(config.readError)),
    [configs, connectionId]
  )
  const visibleConfigs = useMemo(
    () =>
      remoteFilesystemUnavailable
        ? []
        : configs.filter(
            (config) => config.exists || config.status === 'invalid' || config.readError
          ),
    [configs, remoteFilesystemUnavailable]
  )
  const missingConfigs = useMemo(
    () =>
      configs.filter(
        (config) => !config.exists && config.status === 'missing' && !config.readError
      ),
    [configs]
  )
  const serverCount = useMemo(() => countServers(configs), [configs])
  const canCreateStarter = detectedCount === 0 && !remoteFilesystemUnavailable

  const loadConfigs = useCallback(async (): Promise<void> => {
    setLoading(true)
    const next = await Promise.all(
      MCP_CONFIG_CANDIDATES.map(async (candidate): Promise<LoadedInspection> => {
        const absolutePath = joinPath(targetRootPath, candidate.relativePath)
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
    setLoading(false)
  }, [connectionId, targetRootPath])

  useEffect(() => {
    void loadConfigs()
  }, [loadConfigs])

  const handleOpen = (config: LoadedInspection): void => {
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
              {remoteFilesystemUnavailable ? (
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <FileCode2 className="mt-0.5 size-3.5 shrink-0" />
              )}
              {remoteFilesystemUnavailable ? (
                <span>Connect this SSH repo to inspect or add MCP configs.</span>
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
                <div key={config.candidate.relativePath} className="space-y-2 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    {config.status === 'valid' && !config.readError ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-medium">{config.candidate.label}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {config.candidate.relativePath}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${statusClassName(config)}`}
                    >
                      {statusLabel(config)}
                    </span>
                    {config.exists ? (
                      <Button variant="outline" size="xs" onClick={() => handleOpen(config)}>
                        Open
                      </Button>
                    ) : null}
                  </div>

                  {config.error || config.readError ? (
                    <p className="pl-5 text-xs text-destructive">
                      {config.readError ?? config.error}
                    </p>
                  ) : null}

                  {config.servers.length > 0 ? (
                    <div className="grid gap-1.5 pl-5">
                      {config.servers.map((server) => (
                        <div
                          key={server.name}
                          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-xs font-medium">{server.name}</span>
                              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                                {server.transport}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                              {serverDetailLabel(server)}
                            </p>
                            {server.env && Object.keys(server.env).length > 0 ? (
                              <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                                env:{' '}
                                {Object.entries(server.env)
                                  .map(([key, value]) => `${key}=${value}`)
                                  .join(', ')}
                              </p>
                            ) : null}
                          </div>
                          <span className="self-start text-[11px] text-muted-foreground">
                            {server.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {missingConfigs.length > 0 && !remoteFilesystemUnavailable ? (
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
