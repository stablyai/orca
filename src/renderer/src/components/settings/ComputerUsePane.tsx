import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Accessibility,
  Camera,
  ExternalLink,
  MonitorCog,
  RefreshCw,
  ShieldCheck
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionState,
  ComputerUsePermissionStatus
} from '../../../../shared/computer-use-permissions-types'
import {
  COMPUTER_USE_SKILL_INSTALL_COMMAND,
  COMPUTER_USE_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { translate } from '@/i18n/i18n'
export { getComputerUsePaneSearchEntries } from './computer-use-search'

type PermissionDefinition = {
  id: ComputerUsePermissionId
  label: string
  description: string
  icon: ReactNode
}

const PERMISSIONS: PermissionDefinition[] = [
  {
    id: 'accessibility',
    label: translate('auto.components.settings.ComputerUsePane.6b5a2cd3a5', 'Accessibility'),
    description: translate(
      'auto.components.settings.ComputerUsePane.4d03dec2d0',
      'Read app interface trees and perform requested actions.'
    ),
    icon: <Accessibility className="size-4" />
  },
  {
    id: 'screenshots',
    label: translate('auto.components.settings.ComputerUsePane.07bbe4c4cb', 'Screenshots'),
    description: translate(
      'auto.components.settings.ComputerUsePane.0c9a33f468',
      'Capture app windows so agents can inspect visual state.'
    ),
    icon: <Camera className="size-4" />
  }
]

function statusLabel(status: ComputerUsePermissionStatus | undefined): string {
  switch (status) {
    case 'granted':
      return 'Granted'
    case 'unsupported':
      return 'macOS only'
    case 'not-granted':
    case undefined:
      return 'Not enabled'
  }
}

function statusClass(status: ComputerUsePermissionStatus | undefined): string {
  if (status === 'granted') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  return 'border-border bg-muted text-muted-foreground'
}

export function ComputerUsePane(): React.JSX.Element {
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  const [states, setStates] = useState<ComputerUsePermissionState[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState<ComputerUsePermissionId | null>(null)
  const [resetting, setResetting] = useState(false)
  // Why: reset changes OS permission state, so older status probes must not overwrite it.
  const resettingRef = useRef(false)
  const permissionOperationSequence = useRef(0)
  const mountedRef = useRef(true)
  const [helperUnavailableReason, setHelperUnavailableReason] = useState<string | null>(null)
  const {
    installed: computerUseSkillDetected,
    loading: computerUseSkillLoading,
    error: computerUseSkillError,
    refresh: refreshComputerUseSkill
  } = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const stateById = useMemo(
    () => new Map(states.map((state) => [state.id, state.status] as const)),
    [states]
  )
  const grantedCount = PERMISSIONS.filter(
    (permission) => stateById.get(permission.id) === 'granted'
  ).length
  const allGranted = grantedCount === PERMISSIONS.length
  const checking = loading && states.length === 0
  const setupUnavailable = helperUnavailableReason !== null
  const resetAccessDisabled =
    resetting || loading || states.length === 0 || pendingId !== null || setupUnavailable
  const summaryTitle = checking
    ? 'Checking Computer Use access.'
    : setupUnavailable
      ? 'Computer Use is unavailable.'
      : allGranted
        ? 'Computer Use is ready.'
        : 'Finish setup to use local apps.'
  const summaryDescription = checking
    ? 'Orca is checking macOS privacy permissions for the Computer Use helper.'
    : setupUnavailable
      ? `Computer Use permissions are unavailable because ${helperUnavailableReason}.`
      : allGranted
        ? 'Agents can inspect and operate app windows when you ask.'
        : `${PERMISSIONS.length - grantedCount} permission${
            PERMISSIONS.length - grantedCount === 1 ? '' : 's'
          } required before agents can operate app windows.`

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      permissionOperationSequence.current += 1
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (resettingRef.current) {
      return
    }

    const operationId = ++permissionOperationSequence.current
    setLoading(true)
    try {
      const result = await window.api.computerUsePermissions.getStatus()
      if (operationId !== permissionOperationSequence.current) {
        return
      }
      if (!mountedRef.current) {
        return
      }
      setPlatform(result.platform)
      setStates(result.permissions)
      setHelperUnavailableReason(result.helperUnavailableReason)
    } catch (error) {
      if (operationId !== permissionOperationSequence.current || !mountedRef.current) {
        return
      }
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.ComputerUsePane.2168fa5ab0',
              'Could not load Computer Use permissions'
            )
      )
    } finally {
      if (operationId === permissionOperationSequence.current && mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Why: users grant these in System Settings, so refresh when focus returns
  // instead of polling while the settings pane is open.
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const openPermission = async (id: ComputerUsePermissionId): Promise<void> => {
    useAppStore.getState().recordFeatureInteraction('computer-use-setup')
    setPendingId(id)
    try {
      const result = await window.api.computerUsePermissions.openSetup({ id })
      if (!mountedRef.current) {
        return
      }
      if (result.launchedHelper) {
        toast.message(
          translate(
            'auto.components.settings.ComputerUsePane.697005758f',
            'Opened macOS Privacy & Security'
          )
        )
      } else {
        toast.message(
          result.platform === 'darwin'
            ? translate(
                'auto.components.settings.ComputerUsePane.740766c291',
                'Computer Use setup is already complete'
              )
            : translate(
                'auto.components.settings.ComputerUsePane.7801ac08ec',
                'Computer Use permissions are only required on macOS'
              )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.ComputerUsePane.5c45349665',
                'Could not open Computer Use permissions'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setPendingId(null)
      }
    }
  }

  const resetAccess = async (): Promise<void> => {
    if (resettingRef.current) {
      return
    }

    resettingRef.current = true
    const operationId = ++permissionOperationSequence.current
    setResetting(true)
    try {
      const result = await window.api.computerUsePermissions.reset()
      if (operationId !== permissionOperationSequence.current) {
        return
      }
      if (!mountedRef.current) {
        return
      }
      setPlatform(result.platform)
      setStates(result.permissions)
      setHelperUnavailableReason(result.helperUnavailableReason)
      toast.message(
        translate(
          'auto.components.settings.ComputerUsePane.f189f448a3',
          'Reset Computer Use access'
        )
      )
    } catch (error) {
      if (operationId !== permissionOperationSequence.current || !mountedRef.current) {
        return
      }
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.ComputerUsePane.3383ea1aab',
              'Could not reset Computer Use permissions'
            )
      )
    } finally {
      if (operationId === permissionOperationSequence.current && mountedRef.current) {
        resettingRef.current = false
        setResetting(false)
        setLoading(false)
      }
    }
  }

  const isMac = platform === null || platform === 'darwin'

  return (
    <div className="space-y-5">
      {isMac ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                {summaryTitle}
                {allGranted ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                  >
                    {translate('auto.components.settings.ComputerUsePane.0c29da5805', 'Ready')}
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{summaryDescription}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={resetting}
              onClick={() => void refresh()}
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              {translate('auto.components.settings.ComputerUsePane.d95d1cfab8', 'Refresh')}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="divide-y divide-border/60 rounded-lg border border-border/60">
              {PERMISSIONS.map((permission) => {
                const status = stateById.get(permission.id)
                const pending = pendingId === permission.id

                return (
                  <div
                    key={permission.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="mt-0.5 text-muted-foreground">{permission.icon}</div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{permission.label}</span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${statusClass(
                              status
                            )}`}
                          >
                            {statusLabel(status)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">{permission.description}</p>
                      </div>
                    </div>
                    <div className="flex w-28 shrink-0 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          resetting ||
                          pending ||
                          status === 'unsupported' ||
                          helperUnavailableReason !== null
                        }
                        onClick={() => void openPermission(permission.id)}
                        className="gap-1.5"
                      >
                        <ExternalLink className="size-3.5" />
                        {translate('auto.components.settings.ComputerUsePane.45f8e22c2e', 'Open')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              disabled={resetAccessDisabled}
              onClick={() => void resetAccess()}
              className="ml-auto mr-4 block w-28 text-right text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {resetting
                ? translate(
                    'auto.components.settings.ComputerUsePane.506f2acf7a',
                    'Resetting access...'
                  )
                : translate('auto.components.settings.ComputerUsePane.6b17602073', 'Reset access')}
            </button>
          </div>
        </>
      ) : null}

      <AgentSkillSetupPanel
        title={translate(
          'auto.components.settings.ComputerUsePane.93255aaf18',
          'Computer Use skill'
        )}
        description={translate(
          'auto.components.settings.ComputerUsePane.1735461723',
          'Enables agents to inspect and operate local desktop apps.'
        )}
        command={COMPUTER_USE_SKILL_INSTALL_COMMAND}
        terminalTitle="Computer Use setup"
        terminalAriaLabel="Computer Use skill install terminal"
        terminalWorktreeId="settings-computer-use-skill-terminal"
        installed={computerUseSkillDetected}
        loading={computerUseSkillLoading}
        error={computerUseSkillError}
        icon={<MonitorCog className="size-5" />}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        onBeforeOpenTerminal={async () => {
          useAppStore.getState().recordFeatureInteraction('computer-use-setup')
          await ensureOrcaCliAvailableForAgentSkillTerminal()
        }}
        onRecheck={refreshComputerUseSkill}
      />
    </div>
  )
}
