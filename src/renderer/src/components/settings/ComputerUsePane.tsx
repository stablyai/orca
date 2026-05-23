import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { Button } from '../ui/button'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import type { SettingsSearchEntry } from './settings-search'

export const COMPUTER_USE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Computer Use',
    description: 'Allow agents to inspect screenshots and operate local apps when you ask.',
    keywords: [
      'computer use',
      'accessibility',
      'screen recording',
      'screenshot',
      'automation',
      'skill'
    ]
  }
]

type PermissionDefinition = {
  id: ComputerUsePermissionId
  label: string
  description: string
  icon: ReactNode
}

const PERMISSIONS: PermissionDefinition[] = [
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'Read app interface trees and perform requested actions.',
    icon: <Accessibility className="size-4" />
  },
  {
    id: 'screenshots',
    label: 'Screenshots',
    description: 'Capture app windows so agents can inspect visual state.',
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
    default:
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

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.computerUsePermissions.getStatus()
      setPlatform(result.platform)
      setStates(result.permissions)
      setHelperUnavailableReason(result.helperUnavailableReason)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not load Computer Use permissions'
      )
    } finally {
      setLoading(false)
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
    setPendingId(id)
    try {
      const result = await window.api.computerUsePermissions.openSetup({ id })
      if (result.launchedHelper) {
        toast.message('Opened macOS Privacy & Security')
      } else {
        toast.message('Computer Use permissions are only required on macOS')
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not open Computer Use permissions'
      )
    } finally {
      setPendingId(null)
    }
  }

  const isMac = platform === null || platform === 'darwin'

  return (
    <div className="space-y-5">
      {isMac ? (
        <>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                Allow Orca to use local apps when you ask.
              </div>
              <p className="text-xs text-muted-foreground">
                Computer Use needs macOS privacy permissions before agents can inspect and operate
                app windows.
              </p>
              {helperUnavailableReason ? (
                <p className="text-xs text-muted-foreground">
                  Computer Use permissions are unavailable because {helperUnavailableReason}.
                </p>
              ) : null}
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()}>
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      pending || status === 'unsupported' || helperUnavailableReason !== null
                    }
                    onClick={() => void openPermission(permission.id)}
                    className="shrink-0 gap-1.5"
                  >
                    <ExternalLink className="size-3.5" />
                    {pending ? 'Opening...' : 'Open'}
                  </Button>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      <AgentSkillSetupPanel
        title="Computer Use skill"
        detectedDescription="Detected on this machine. Agents can use Orca's computer controls."
        missingDescription="Agents need this skill before they can use Orca's computer controls. If you already installed it, click Re-check instead of running the installer again."
        command={COMPUTER_USE_SKILL_INSTALL_COMMAND}
        terminalTitle="Computer Use setup"
        terminalAriaLabel="Computer Use skill install terminal"
        terminalWorktreeId="settings-computer-use-skill-terminal"
        installed={computerUseSkillDetected}
        detected={computerUseSkillDetected}
        loading={computerUseSkillLoading}
        error={computerUseSkillError}
        icon={<MonitorCog className="size-5" />}
        onRecheck={refreshComputerUseSkill}
      />
    </div>
  )
}
