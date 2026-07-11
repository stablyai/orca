import { useCallback, useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { getRepoDisplayPath } from '../../../../shared/wsl-repo-identity'
import type { ProjectExecutionRuntimeRepairReason } from '../../../../shared/project-execution-runtime'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { getRepositoryRuntimeSectionId } from '@/components/settings/repository-settings-targets'
import { translate } from '@/i18n/i18n'

type WslProjectBadgeProps = {
  repoId: string
  repoPath: string
}

/**
 * Row badge for a local Windows project running in WSL: `WSL: <distro>` when
 * healthy, or an alert affordance when the runtime needs repair. Clicking
 * either state opens the project's runtime settings — same resolver and
 * repair copy as ProjectWindowsRuntimeSetting, no separate repair path.
 */
export function WslProjectBadge({
  repoId,
  repoPath
}: WslProjectBadgeProps): React.JSX.Element | null {
  const appPlatform = getRendererAppPlatform()
  const runtimeState = useAppStore(
    useShallow((state) => ({
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      projects: state.projects,
      repos: state.repos,
      settings: state.settings,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const windowsCapabilities = useWindowsTerminalCapabilities(appPlatform === 'win32')
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const resolution = useMemo(
    () =>
      getLocalRepoProjectExecutionRuntimeContext(runtimeState, repoId, appPlatform, {
        wslAvailable: windowsCapabilities.isLoading ? undefined : windowsCapabilities.wslAvailable,
        availableWslDistros: windowsCapabilities.isLoading ? null : windowsCapabilities.wslDistros
      }),
    [runtimeState, repoId, appPlatform, windowsCapabilities]
  )

  const handleOpenRuntimeSettings = useCallback(() => {
    openSettingsTarget({
      pane: 'repo',
      repoId,
      sectionId: getRepositoryRuntimeSectionId(repoId)
    })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget, repoId])

  if (!resolution) {
    return null
  }
  // Why: narrow the resolver's discriminated union in one place instead of
  // re-checking resolution.status/runtime.kind through the rest of render.
  let isRepair: boolean
  let distro: string | null
  let repairReason: ProjectExecutionRuntimeRepairReason | null
  if (resolution.status === 'repair-required') {
    isRepair = true
    distro = resolution.repair.preferredRuntime.distro
    repairReason = resolution.repair.reason
  } else if (resolution.runtime.kind === 'wsl') {
    isRepair = false
    distro = resolution.runtime.distro
    repairReason = null
  } else {
    return null
  }

  const displayPath = getRepoDisplayPath(repoPath)
  const label = isRepair
    ? translate('auto.components.sidebar.WslProjectBadge.wslRepairLabel', 'WSL')
    : translate('auto.components.sidebar.WslProjectBadge.wslHealthyLabel', 'WSL: {{value0}}', {
        value0: distro
      })
  const ariaLabel = isRepair
    ? translate(
        'auto.components.sidebar.WslProjectBadge.wslRepairAriaLabel',
        'WSL runtime needs attention. Open runtime settings.'
      )
    : translate(
        'auto.components.sidebar.WslProjectBadge.wslHealthyAriaLabel',
        'Runs in WSL ({{value0}}). Open runtime settings.',
        { value0: distro }
      )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleOpenRuntimeSettings}
          aria-label={ariaLabel}
          className={cn(
            'inline-flex h-4 max-w-[6.5rem] shrink-0 items-center gap-1 rounded border px-1.5 text-[9px] font-medium leading-none',
            isRepair
              ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
              : 'border-border bg-accent text-muted-foreground hover:bg-accent/80 dark:bg-accent/50 dark:border-border/60'
          )}
        >
          {isRepair ? <TriangleAlert className="size-2.5 shrink-0" aria-hidden="true" /> : null}
          <span className="truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        {isRepair && repairReason ? (
          <div className="space-y-1">
            <div className="font-medium">{getRepairTooltipTitle(repairReason)}</div>
            <div className="text-muted-foreground">{displayPath}</div>
          </div>
        ) : (
          displayPath
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function getRepairTooltipTitle(reason: ProjectExecutionRuntimeRepairReason): string {
  switch (reason) {
    case 'wsl-unavailable':
      return translate(
        'auto.components.sidebar.WslProjectBadge.wslUnavailable',
        'WSL is not available. Open runtime settings to repair.'
      )
    case 'wsl-distro-missing':
      return translate(
        'auto.components.sidebar.WslProjectBadge.wslDistroMissing',
        'The configured distro is missing. Open runtime settings to choose another.'
      )
    case 'wsl-distro-required':
      return translate(
        'auto.components.sidebar.WslProjectBadge.wslDistroRequired',
        'Choose a WSL distro in runtime settings.'
      )
  }
}
