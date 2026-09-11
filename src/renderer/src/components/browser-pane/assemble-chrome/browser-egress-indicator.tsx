import { useState } from 'react'
import { Globe, Monitor, Server } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID,
  BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID
} from '@/lib/settings-navigation-types'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host'
import { getHostSettingOverride } from '../../../../../shared/host-setting-overrides'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveSshWorkspaceBrowserRouteEligibility } from '@/lib/ssh-workspace-browser-route-eligibility'

/**
 * The address bar's leading icon, egress-aware: pages that render locally and
 * pages whose traffic leaves from a remote host look identical when working,
 * so the globe slot becomes the one visible tell of where a page's traffic
 * leaves from. Hover shows the summary; clicking expands the explanation and
 * a settings link.
 */
function EgressIndicatorButton({
  icon,
  egress,
  description,
  detail,
  settingsSectionId
}: {
  icon: React.ReactNode
  egress: 'ssh' | 'local' | 'remote'
  description: string
  detail: string
  settingsSectionId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      {/* Why: suppress the hover tooltip while the popover is open — both anchor below the icon and would overlap. */}
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={description}
              data-testid="ssh-egress-indicator"
              data-egress={egress}
              // Why: the address bar form focuses its input on any click inside it.
              onClick={(event) => event.stopPropagation()}
            >
              {icon}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          {description}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-72 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-medium text-foreground">{description}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="mt-1.5 h-auto px-0"
          data-testid="ssh-egress-indicator-settings"
          onClick={() => {
            setOpen(false)
            openSettingsTarget({
              pane: 'browser',
              repoId: null,
              sectionId: settingsSectionId
            })
            openSettingsPage()
          }}
        >
          {translate('browser.sshEgress.settingsLink', 'Routing settings')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

/** Local browser pages in an SSH workspace: routed through the host, or opted out. */
export function SshEgressIndicator({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const executionHostId = useAppStore((s) => getExecutionHostIdForWorktree(s, worktreeId))
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const settings = useAppStore((s) => s.settings)
  const routeEligibility = resolveSshWorkspaceBrowserRouteEligibility(executionHostId, settings)
  if (!routeEligibility) {
    return <Globe className="size-4 shrink-0 text-muted-foreground" />
  }
  const { targetId, eligible: routed } = routeEligibility
  const hostLabel =
    getHostSettingOverride(settings, toSshExecutionHostId(targetId), 'displayLabel') ??
    sshTargetLabels.get(targetId) ??
    targetId
  return (
    <EgressIndicatorButton
      icon={routed ? <Server className="size-4" /> : <Monitor className="size-4" />}
      egress={routed ? 'ssh' : 'local'}
      description={
        routed
          ? translate('browser.sshEgress.routedTooltip', 'Browsing through {{value0}}', {
              value0: hostLabel
            })
          : translate(
              'browser.sshEgress.localTooltip',
              'Browsing from this device, not {{value0}}',
              {
                value0: hostLabel
              }
            )
      }
      detail={
        routed
          ? translate(
              'browser.sshEgress.routedDetail',
              "Network traffic and DNS go through the workspace's SSH host."
            )
          : translate(
              'browser.sshEgress.localDetail',
              'Pages load from this machine and its network.'
            )
      }
      settingsSectionId={BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID}
    />
  )
}

/** Remote-runtime browser pages: client-hosted (renders here) or streamed from the host. */
export function RemoteRuntimeEgressIndicator({
  runtimeEnvironmentId,
  presentation
}: {
  runtimeEnvironmentId: string
  presentation: 'client-hosted' | 'streamed'
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const environmentName = useAppStore(
    (s) =>
      s.runtimeEnvironments.find((environment) => environment.id === runtimeEnvironmentId)?.name
  )
  const hostLabel =
    getHostSettingOverride(
      settings,
      toRuntimeExecutionHostId(runtimeEnvironmentId),
      'displayLabel'
    ) ??
    environmentName ??
    runtimeEnvironmentId
  const clientHosted = presentation === 'client-hosted'
  return (
    <EgressIndicatorButton
      icon={<Server className="size-4" />}
      egress="remote"
      description={
        clientHosted
          ? translate('browser.remoteEgress.clientHostedTooltip', 'Browsing through {{value0}}', {
              value0: hostLabel
            })
          : translate('browser.remoteEgress.streamedTooltip', 'Browsing on {{value0}}', {
              value0: hostLabel
            })
      }
      detail={
        clientHosted
          ? translate(
              'browser.remoteEgress.clientHostedDetail',
              'The page renders on this device. Network traffic and DNS go through the remote host.'
            )
          : translate(
              'browser.remoteEgress.streamedDetail',
              'The page runs on the remote host and streams to this device.'
            )
      }
      settingsSectionId={BROWSER_CLIENT_HOSTED_REMOTE_SETTINGS_TARGET_ID}
    />
  )
}
