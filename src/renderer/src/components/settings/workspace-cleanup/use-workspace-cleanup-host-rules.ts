import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  getDefaultWorkspaceCleanupRules,
  normalizeWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { errorMessage } from '../../../../../shared/error-message'

/** `unsupported`: a host from before automatic cleanup, which neither reports nor accepts the rules. */
export type WorkspaceCleanupHostRules =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'error'; message: string }
  | { state: 'ready'; rules: WorkspaceCleanupRules }

type HostSettings = { settings: Partial<GlobalSettings> }

const HOST_SETTINGS_TIMEOUT_MS = 15_000

function readHostRules(settings: Partial<GlobalSettings>): WorkspaceCleanupHostRules {
  // Newer hosts always report the key; an older one would reject the strict settings.update.
  return settings.workspaceCleanupPolicy
    ? { state: 'ready', rules: normalizeWorkspaceCleanupRules(settings.workspaceCleanupPolicy) }
    : { state: 'unsupported' }
}

function readEnvironmentRules(environmentId: string): Promise<WorkspaceCleanupHostRules> {
  return callRuntimeRpc<HostSettings>(
    { kind: 'environment', environmentId },
    'settings.get',
    undefined,
    {
      timeoutMs: HOST_SETTINGS_TIMEOUT_MS
    }
  ).then(
    (result) => readHostRules(result.settings),
    (error: unknown): WorkspaceCleanupHostRules => ({
      state: 'error',
      message: errorMessage(error)
    })
  )
}

/** The rules belong to the host that owns the repos, so this reads and writes that host's settings. */
export function useWorkspaceCleanupHostRules(
  owner: RuntimeClientTarget,
  localSettings: Pick<GlobalSettings, 'workspaceCleanupPolicy'> | null,
  updateLocalSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
): {
  hostRules: WorkspaceCleanupHostRules
  /** The host's rules as they are now; another client may have changed them since the last read. */
  readLatest: () => Promise<WorkspaceCleanupRules | null>
  reload: () => void
  update: (rules: WorkspaceCleanupRules) => Promise<boolean>
} {
  const t = useTranslate()
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const [remote, setRemote] = useState<{
    environmentId: string
    hostRules: WorkspaceCleanupHostRules
  } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!environmentId) {
      return
    }
    let current = true
    void readEnvironmentRules(environmentId).then((hostRules) => {
      if (current) {
        setRemote({ environmentId, hostRules })
      }
    })
    return () => {
      current = false
    }
  }, [environmentId, attempt])

  const reportFailure = (error: unknown): void => {
    toast.error(
      t('components.settings.workspaceCleanup.updateFailed', "Couldn't save the cleanup rules."),
      { description: errorMessage(error) }
    )
  }
  const reload = (): void => setAttempt((value) => value + 1)

  if (!environmentId) {
    const localRules = localSettings
      ? (localSettings.workspaceCleanupPolicy ?? getDefaultWorkspaceCleanupRules())
      : null
    return {
      hostRules: localRules ? { state: 'ready', rules: localRules } : { state: 'loading' },
      // The store follows this app's settings as they change, so its copy is current.
      readLatest: () => Promise.resolve(localRules),
      reload,
      update: async (rules) => {
        try {
          await updateLocalSettings({ workspaceCleanupPolicy: rules })
          return true
        } catch (error) {
          reportFailure(error)
          return false
        }
      }
    }
  }
  return {
    hostRules: remote?.environmentId === environmentId ? remote.hostRules : { state: 'loading' },
    readLatest: async () => {
      const hostRules = await readEnvironmentRules(environmentId)
      setRemote({ environmentId, hostRules })
      return hostRules.state === 'ready' ? hostRules.rules : null
    },
    reload,
    update: async (rules) => {
      try {
        const result = await callRuntimeRpc<HostSettings>(
          { kind: 'environment', environmentId },
          'settings.update',
          { workspaceCleanupPolicy: rules },
          { timeoutMs: HOST_SETTINGS_TIMEOUT_MS }
        )
        setRemote({ environmentId, hostRules: readHostRules(result.settings) })
        return true
      } catch (error) {
        reportFailure(error)
        return false
      }
    }
  }
}
