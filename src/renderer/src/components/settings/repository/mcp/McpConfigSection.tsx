import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, FileCode2, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { composeWorktreeId, getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  canInspectLocalMcpConfigRoot,
  inspectMcpConfigContent,
  MCP_CONFIG_CANDIDATES,
  MCP_STARTER_CONFIG
} from '../../../../../../shared/mcp-config'
import { useAppStore } from '../../../../store/index'
import { selectRuntimeAwareSshStatus } from '../../../../store/slices/ssh/runtime-environment-ssh-selectors'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../../../../store/slices/worktrees/listing/worktree-host-ownership'
import { joinPath } from '../../../../lib/path'
import { extractIpcErrorMessage } from '../../../../lib/ipc-error'
import { Button } from '../../../ui/button'
import { isWindowsUserAgent } from '../../../../lib/user-agent-platform'
import { McpConfigFileRow } from './McpConfigFileRow'
import { McpMissingConfigList } from './McpMissingConfigList'
import {
  type LoadedMcpConfigInspection,
  loadMcpConfigInspections
} from '../../../../runtime/mcp/configuration/mcp-config-inspection'
import { formatMcpConfigSummary } from './mcp-config-summary'
import { useTranslate } from '@/i18n/use-translate'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { writeRuntimeFile } from '@/runtime/files/mutations/runtime-file-mutation-client'
import {
  assertFileWriteApplied,
  missingOrIdenticalPrecondition
} from '../../../../../../shared/file-write/file-write-disk-precondition'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type McpConfigSectionProps = {
  repo: Repo
}

const EMPTY_WORKTREES: Worktree[] = []

export function McpConfigSection({ repo }: McpConfigSectionProps): React.JSX.Element {
  const t = useTranslate()
  const openFile = useAppStore((state) => state.openFile)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)
  const ensureWorktreeRootGroup = useAppStore((state) => state.ensureWorktreeRootGroup)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const repos = useAppStore((state) => state.repos)
  const allWorktreesForRepo = useAppStore(
    (state) => selectWorktreesByRepo(state)[repo.id] ?? EMPTY_WORKTREES
  )
  // Paths belong to the repo row’s host, independent of focused host.
  const repoHostId = getRepoExecutionHostId(repo)
  const repoHost = parseExecutionHostId(repoHostId)
  const runtimeEnvironmentId = repoHost?.kind === 'runtime' ? repoHost.environmentId : null
  const connectionId = getRepoSshConnectionId(repo) ?? undefined
  const worktreesForRepo = useMemo(() => {
    const options = worktreeHostMatchOptions({ repos }, repo.id, repoHostId)
    return allWorktreesForRepo.filter((worktree) =>
      worktreeMatchesHost(worktree, repoHostId, options)
    )
  }, [allWorktreesForRepo, repo.id, repoHostId, repos])
  const sshConnectionStatus = useAppStore((state) =>
    connectionId ? selectRuntimeAwareSshStatus(state, runtimeEnvironmentId, connectionId) : null
  )
  const [configs, setConfigs] = useState<LoadedMcpConfigInspection[]>([])
  const [loading, setLoading] = useState(true)
  const [createConfirm, setCreateConfirm] = useState(false)
  const createConfirmResetTimerRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()
  const [inspectionUnavailableMessage, setInspectionUnavailableMessage] = useState<string | null>(
    null
  )

  const isWindows = isWindowsUserAgent()
  const targetWorktree = useMemo((): Pick<Worktree, 'id' | 'path' | 'hostId'> => {
    if (activeWorktreeId && getRepoIdFromWorktreeId(activeWorktreeId) === repo.id) {
      const active = worktreesForRepo.find((worktree) => worktree.id === activeWorktreeId)
      if (active) {
        return active
      }
      // Another host’s active row cannot lend this repo its worktree ID.
      if (!allWorktreesForRepo.some((worktree) => worktree.id === activeWorktreeId)) {
        return { id: activeWorktreeId, path: repo.path }
      }
    }
    return (
      worktreesForRepo.find((worktree) => worktree.isMainWorktree) ??
      worktreesForRepo.find((worktree) => worktree.path === repo.path) ??
      worktreesForRepo[0] ?? { id: composeWorktreeId(repo.id, repo.path), path: repo.path }
    )
  }, [activeWorktreeId, allWorktreesForRepo, repo.id, repo.path, worktreesForRepo])
  const targetWorktreeId = targetWorktree.id
  const targetRootPath = targetWorktree.path
  const targetHostId = getWorktreeExecutionHostId(targetWorktree, repo)
  const fileContext = useMemo(
    (): RuntimeFileOperationArgs => ({
      target: runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
      worktreeId: targetWorktreeId,
      worktreePath: targetRootPath,
      connectionId
    }),
    [connectionId, runtimeEnvironmentId, targetRootPath, targetWorktreeId]
  )
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
      MCP_CONFIG_CANDIDATES.map((candidate): LoadedMcpConfigInspection => ({
        ...inspectMcpConfigContent(candidate, null),
        absolutePath: joinPath(targetRootPath, candidate.relativePath)
      })),
    [targetRootPath]
  )
  const canCreateStarter = detectedCount === 0 && !inspectionUnavailable

  const loadConfigs = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) {
      return
    }
    setLoading(true)
    setInspectionUnavailableMessage(null)

    try {
      if (connectionId && sshConnectionStatus !== 'connected') {
        if (mountedRef.current) {
          setConfigs(missingInspections)
          setInspectionUnavailableMessage('Connect this SSH repo to inspect or add MCP configs.')
        }
        return
      }

      const isDesktopPath = !connectionId && !runtimeEnvironmentId
      if (isDesktopPath && !canInspectLocalMcpConfigRoot(targetRootPath, isWindows)) {
        if (mountedRef.current) {
          setConfigs(missingInspections)
          setInspectionUnavailableMessage('This workspace path is not available from this host.')
        }
        return
      }

      if (isDesktopPath && !(await window.api.shell.pathExists(targetRootPath))) {
        if (mountedRef.current) {
          setConfigs(missingInspections)
          setInspectionUnavailableMessage('This workspace path is not available on disk.')
        }
        return
      }

      const next = await loadMcpConfigInspections(targetRootPath, fileContext)
      if (mountedRef.current) {
        setConfigs(next)
      }
    } catch (error) {
      if (mountedRef.current) {
        setConfigs(missingInspections)
        setInspectionUnavailableMessage(
          extractIpcErrorMessage(error, 'Unable to inspect MCP configs.')
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [
    connectionId,
    fileContext,
    isWindows,
    missingInspections,
    mountedRef,
    runtimeEnvironmentId,
    sshConnectionStatus,
    targetRootPath
  ])

  const clearCreateConfirmResetTimer = useCallback((): void => {
    if (createConfirmResetTimerRef.current !== null) {
      window.clearTimeout(createConfirmResetTimerRef.current)
      createConfirmResetTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    void loadConfigs()
    return clearCreateConfirmResetTimer
  }, [clearCreateConfirmResetTimer, loadConfigs])

  const handleOpen = (config: LoadedMcpConfigInspection): void => {
    setActiveWorktree(targetWorktreeId, targetHostId)
    const targetGroupId = ensureWorktreeRootGroup(targetWorktreeId)
    openFile(
      {
        filePath: config.absolutePath,
        relativePath: config.candidate.relativePath,
        worktreeId: targetWorktreeId,
        language: 'json',
        runtimeEnvironmentId,
        mode: 'edit'
      },
      { targetGroupId, suppressActiveRuntimeFallback: runtimeEnvironmentId === null }
    )
    setActiveView('terminal')
  }

  const handleCreateStarter = async (): Promise<void> => {
    if (!createConfirm) {
      clearCreateConfirmResetTimer()
      setCreateConfirm(true)
      createConfirmResetTimerRef.current = window.setTimeout(() => {
        createConfirmResetTimerRef.current = null
        if (mountedRef.current) {
          setCreateConfirm(false)
        }
      }, 3000)
      return
    }

    const target = joinPath(targetRootPath, '.mcp.json')
    try {
      const sshExpectation = connectionId
        ? captureDirectSshMutationExpectation(
            useAppStore.getState(),
            connectionId,
            runtimeEnvironmentId
          )
        : {}
      // Create only root workspace config; avoid agent-specific layouts and refuse to overwrite files created since the listing.
      assertFileWriteApplied(
        await writeRuntimeFile(
          { ...fileContext, ...sshExpectation },
          target,
          MCP_STARTER_CONFIG,
          undefined,
          missingOrIdenticalPrecondition(MCP_STARTER_CONFIG)
        )
      )
      clearCreateConfirmResetTimer()
      if (mountedRef.current) {
        setCreateConfirm(false)
      }
      await loadConfigs()
      setActiveWorktree(targetWorktreeId, targetHostId)
      const targetGroupId = ensureWorktreeRootGroup(targetWorktreeId)
      openFile(
        {
          filePath: target,
          relativePath: '.mcp.json',
          worktreeId: targetWorktreeId,
          language: 'json',
          runtimeEnvironmentId,
          mode: 'edit'
        },
        { targetGroupId, suppressActiveRuntimeFallback: runtimeEnvironmentId === null }
      )
      setActiveView('terminal')
      toast.success(
        t('auto.components.settings.McpConfigSection.1f3665e35a', 'MCP config created'),
        {
          description: t('auto.components.settings.McpConfigSection.9ee215caf6', '.mcp.json')
        }
      )
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, 'Failed to create MCP config.'))
    }
  }

  return (
    <SettingsGroup
      title={t('auto.components.settings.McpConfigSection.283bebb198', 'MCP configs')}
      description={
        <>
          {t(
            'auto.components.settings.McpConfigSection.96f5609b04',
            'Inspect MCP server definitions that agents can use while working in this repo.'
          )}
          {connectionId ? (
            <span className="block">
              {t(
                'auto.components.settings.McpConfigSection.6bac9ddfc6',
                'SSH repos are read through the remote filesystem. Starter creation is limited to the workspace root config.'
              )}
            </span>
          ) : null}
        </>
      }
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadConfigs()}
            aria-label={t(
              'auto.components.settings.McpConfigSection.f34c152dc0',
              'Refresh MCP configs'
            )}
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
              {createConfirm
                ? t('auto.components.settings.McpConfigSection.0a5c1ead54', 'Create empty config')
                : t('auto.components.settings.McpConfigSection.82436439eb', 'Add MCP config')}
            </Button>
          ) : null}
        </div>
      }
    >
      <div
        data-settings-row=""
        className="flex items-center justify-between py-3 text-xs text-muted-foreground"
      >
        <span>{formatMcpConfigSummary(configs, t)}</span>
        {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      </div>
      {visibleConfigs.length === 0 ? (
        <div
          data-settings-row=""
          className="flex items-start gap-2 py-3 text-xs text-muted-foreground"
        >
          {inspectionUnavailable ? (
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <FileCode2 className="mt-0.5 size-3.5 shrink-0" />
          )}
          {inspectionUnavailable ? (
            <span>{inspectionUnavailableMessage}</span>
          ) : (
            <span>
              {t(
                'auto.components.settings.McpConfigSection.b900cd6282',
                'No MCP config found. Add an empty workspace config when you want this repo to define its own MCP servers.'
              )}
            </span>
          )}
        </div>
      ) : (
        visibleConfigs.map((config) => (
          <McpConfigFileRow
            key={config.candidate.relativePath}
            config={config}
            onOpen={handleOpen}
          />
        ))
      )}

      {!inspectionUnavailable ? <McpMissingConfigList missingConfigs={missingConfigs} /> : null}
    </SettingsGroup>
  )
}
