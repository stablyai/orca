import { useRef, useState } from 'react'
import { ExternalLink, MoreHorizontal } from 'lucide-react'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Switch } from '../../../ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../../ui/dropdown-menu'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import {
  type AgentSessionSourceHomeControl,
  AgentSessionSourceHomeInput
} from '../../../agent/launch-settings/codex-session-source-home-control'
import { resolveTuiAgentPermissionMode } from '../../../../../../shared/agent-launch/permissions/tui-agent-permissions'
import { stringifyAgentDefaultEnvDraft } from '../../../agent/launch-settings/agent-default-env-draft'
import { liftAgentPermissionArgs } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import {
  AgentPermissionExceptionBadge,
  AgentRowPermissionControl,
  type AgentRowPermission
} from '../permissions/AgentRowPermissions'
import {
  AgentCommandOverrideInput,
  AgentDefaultArgsInput,
  AgentDefaultEnvInput
} from '../../../agent/launch-settings/AgentLaunchDefaultsEditor'
import { agentPermissionChoiceLabel } from '../../../agent/launch-settings/agent-permission-choice-label'
import { AgentPermissionMenu } from '../../../agent/launch-settings/AgentPermissionMenu'
import type { AgentPermissionChoiceRow } from '../../../agent/launch-settings/agent-permission-choice-row'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import type { AgentOpensAs } from '../../../../lib/agent-session/launch/native-chat-provider-choice'
import { AgentOpensAsControl } from '../../../agent/launch-settings/AgentChatChoiceControls'

const OPENS_AS_PLACEHOLDER: AgentOpensAs = { value: 'chat', cliMissing: false, onChange: () => {} }

export type AgentCatalogRowProps = {
  agentId: TuiAgent
  label: string
  homepageUrl: string
  defaultCmd: string
  defaultArgs: string
  defaultEnv: Record<string, string>
  isDetected: boolean
  isEnabled: boolean
  /** 'chosen' when saved as the default; 'auto' when Auto resolves to this agent. */
  defaultMark: 'chosen' | 'auto' | null
  /** Saved as the default, even when not installed now, so it can still be cleared. */
  isSavedDefault: boolean
  cmdOverride: string | undefined
  argsOverride: string
  envOverride: Record<string, string>
  /** True saves this agent as the default; false goes back to Auto. */
  onSetDefault: (isDefault: boolean) => void
  onSetEnabled: (enabled: boolean) => void
  onSaveOverride: (value: string) => void | Promise<void>
  onSaveArgs: (value: string) => void | Promise<void>
  onSaveEnv: (value: Record<string, string>) => void | Promise<void>
  sessionSourceHome?: AgentSessionSourceHomeControl
  environmentNames?: readonly string[]
  /** Absent for agents without a configurable permission mode on this host. */
  permission?: AgentRowPermission
  /** On hosts that store the permission apart from Arguments; replaces `permission`. */
  permissionChoice?: AgentPermissionChoiceRow
  /** The text a terminal launch gets, when it differs from the editable Arguments. */
  launchArgs?: string
  environmentEditor?: React.ReactNode
  /** Whether new sessions open as a chat or the CLI; absent where this computer offers no choice. */
  opensAs?: AgentOpensAs
  /** Leaves room for the Chat | CLI choice on rows without it, so columns line up. */
  reserveOpensAsSlot?: boolean
  /** The downloaded chat program's install and sign-in, shown in the row's details. */
  chatRuntime?: React.ReactNode
  launchChoiceEditor?: (permissionControlRef: React.Ref<HTMLDivElement>) => React.ReactNode
}

export function AgentCatalogRow({
  agentId,
  label,
  homepageUrl,
  defaultCmd,
  defaultArgs,
  defaultEnv,
  isDetected,
  isEnabled,
  defaultMark,
  isSavedDefault,
  cmdOverride,
  argsOverride,
  envOverride,
  onSetDefault,
  onSetEnabled,
  onSaveOverride,
  onSaveArgs,
  onSaveEnv,
  sessionSourceHome,
  environmentNames,
  environmentEditor,
  launchChoiceEditor,
  permission,
  permissionChoice,
  launchArgs = argsOverride,
  opensAs,
  reserveOpensAsSlot = false,
  chatRuntime
}: AgentCatalogRowProps): React.JSX.Element {
  const t = useTranslate()
  const envSummary = environmentNames?.join(' ') ?? stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const [cmdOpen, setCmdOpen] = useState(
    Boolean(cmdOverride) ||
      (argsOverride !== defaultArgs &&
        resolveTuiAgentPermissionMode({
          agent: agentId,
          agentArgs: argsOverride,
          agentEnv: envOverride
        }) === 'mixed') ||
      envSummary !== defaultEnvSummary
  )
  const permissionRef = useRef<HTMLDivElement>(null)
  const openPermission = (): void => {
    setCmdOpen(true)
    requestAnimationFrame(() => {
      const control = permissionRef.current
      ;(
        control?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        control?.querySelector<HTMLElement>('button')
      )?.focus()
    })
  }
  const toggleOpen = (): void => setCmdOpen((previous) => !previous)
  return (
    <div className={cn('py-3', !isDetected && !opensAs?.cliMissing && 'opacity-70')}>
      {/* Clicking the row's empty space expands it; its controls and the name button handle their own clicks. */}
      <div
        className="-mx-2 flex cursor-pointer flex-wrap items-center gap-3 rounded-md px-2 py-1 transition-colors hover:bg-accent"
        onClick={(event) => {
          const target = event.target
          // React bubbles clicks from the portaled menu here too; only the row's own empty space toggles.
          if (
            target instanceof Element &&
            event.currentTarget.contains(target) &&
            !target.closest('button, a, input')
          ) {
            toggleOpen()
          }
        }}
      >
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50',
            !isEnabled && 'opacity-45'
          )}
        >
          <AgentIcon agent={agentId} size={16} />
        </div>
        <div className="flex-1 max-sm:min-w-0 sm:min-w-48">
          {/* Badges overhang the name line so rows with one stay the same height. */}
          <div className="flex flex-wrap items-center gap-2 [&>*+*]:-my-1">
            <button
              type="button"
              onClick={toggleOpen}
              aria-expanded={cmdOpen}
              className={cn(
                'rounded-sm text-sm leading-none font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                !isEnabled && 'opacity-45'
              )}
            >
              {label}
            </button>
            {defaultMark && (
              <SettingsBadge className="border-foreground/30 text-foreground">
                {defaultMark === 'auto'
                  ? t('settings.agents.defaultAutoBadge', 'Default · Auto')
                  : t('auto.components.settings.AgentsPane.24e032fa34', 'Default')}
              </SettingsBadge>
            )}
            {permissionChoice?.source === 'agent' && (
              <button
                type="button"
                onClick={openPermission}
                className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <SettingsBadge tone="accent">
                  {agentPermissionChoiceLabel(permissionChoice.choice, label, t)}
                </SettingsBadge>
              </button>
            )}
            {permission && permission.mode !== permission.expectedMode && (
              <AgentPermissionExceptionBadge
                label={label}
                permission={permission}
                onSelect={openPermission}
              />
            )}
          </div>
          <div
            className={cn(
              'mt-1 truncate font-mono text-[11px] text-muted-foreground',
              !isEnabled && 'opacity-45'
            )}
          >
            {cmdOverride ? (
              <span>
                <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
                <span className="ml-1.5 text-foreground/80">{cmdOverride}</span>
              </span>
            ) : (
              defaultCmd
            )}
            {launchArgs && <span className="ml-1.5 text-foreground/70">{launchArgs}</span>}
            {envSummary && <span className="ml-1.5 text-foreground/60">{envSummary}</span>}
          </div>
        </div>

        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-3">
          {opensAs ? (
            <div className={cn(!isEnabled && 'opacity-40')}>
              <AgentOpensAsControl label={label} opensAs={opensAs} disabled={!isEnabled} />
            </div>
          ) : (
            reserveOpensAsSlot && (
              // Keeps the switch and menu columns aligned with rows that have the choice.
              <div aria-hidden className="invisible">
                <AgentOpensAsControl label={label} opensAs={OPENS_AS_PLACEHOLDER} />
              </div>
            )
          )}
          <Switch
            checked={isEnabled}
            onCheckedChange={onSetEnabled}
            aria-label={t(
              'auto.components.settings.AgentsPane.1c9a9679ec',
              '{{value0}} availability',
              {
                value0: label
              }
            )}
          />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('settings.agents.agentActions', '{{agent}} actions', {
                  agent: label
                })}
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                disabled={!isSavedDefault && !(isDetected && isEnabled)}
                onSelect={() => onSetDefault(!isSavedDefault)}
              >
                {isSavedDefault
                  ? t('settings.agents.clearDefault', 'Clear default agent')
                  : t('auto.components.settings.AgentsPane.5f986a9b92', 'Set as default')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href={homepageUrl}
                  target="_blank"
                  onClick={openAppHttpLinkFromAnchor}
                  rel="noopener noreferrer"
                >
                  {isDetected
                    ? t('auto.components.settings.AgentsPane.fe4d630c94', 'Docs')
                    : t('auto.components.settings.AgentsPane.f95b5c79b8', 'Install')}
                  <ExternalLink className="ml-auto size-3" />
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {cmdOpen && (
        <div className="mt-3 space-y-3 pl-10">
          {chatRuntime}
          {!launchChoiceEditor && permissionChoice && (
            <div ref={permissionRef}>
              <AgentPermissionMenu agentId={agentId} label={label} permission={permissionChoice} />
            </div>
          )}
          {permission && (
            <AgentRowPermissionControl
              label={label}
              permission={permission}
              controlRef={permissionRef}
            />
          )}
          {!isDetected && launchChoiceEditor?.(permissionRef)}
          {!isDetected && (
            <div>
              <AgentCommandOverrideInput
                key={cmdOverride ?? defaultCmd}
                defaultCmd={defaultCmd}
                cmdOverride={cmdOverride}
                onSaveOverride={onSaveOverride}
              />
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t(
                  'settings.agents.undetectedCommandHint',
                  'If the {{agent}} CLI is installed outside PATH, enter the full path to its executable on this host.',
                  { agent: label }
                )}
              </p>
            </div>
          )}
          {isDetected && (
            <div>
              <AgentCommandOverrideInput
                key={cmdOverride ?? defaultCmd}
                defaultCmd={defaultCmd}
                cmdOverride={cmdOverride}
                onSaveOverride={onSaveOverride}
              />
              <div className="mt-2">
                {launchChoiceEditor?.(permissionRef) ?? (
                  <AgentDefaultArgsInput
                    key={agentId}
                    defaultArgs={defaultArgs}
                    argsOverride={argsOverride}
                    onSaveArgs={onSaveArgs}
                    choiceChips={
                      permissionChoice?.flag && !permissionChoice.argsSetPermission
                        ? [
                            {
                              key: 'permissionMode',
                              label,
                              flag: permissionChoice.flag,
                              onRemove: (text) => {
                                const lifted = liftAgentPermissionArgs(agentId, text)
                                permissionChoice.onSelect('own')
                                return lifted.choice !== null ? lifted.args : text
                              }
                            }
                          ]
                        : undefined
                    }
                    note={
                      permissionChoice?.argsSetPermission
                        ? t(
                            'settings.agents.permissionArgsTerminalOnly',
                            'These arguments may control {{agent}}’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.',
                            { agent: label }
                          )
                        : undefined
                    }
                  />
                )}
              </div>
              {environmentEditor ?? (
                <div className="mt-2">
                  <AgentDefaultEnvInput
                    key={agentId}
                    defaultEnv={defaultEnv}
                    envOverride={envOverride}
                    onSaveEnv={onSaveEnv}
                  />
                </div>
              )}
              {sessionSourceHome && (
                <div className="mt-2">
                  <AgentSessionSourceHomeInput
                    key={`${agentId}:${sessionSourceHome.runtimeLabel}:${sessionSourceHome.value}`}
                    runtimeLabel={sessionSourceHome.runtimeLabel}
                    value={sessionSourceHome.value}
                    onSave={sessionSourceHome.onSave}
                  />
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t(
                  'auto.components.settings.AgentsPane.f9f127d664',
                  'Override the binary path or name, and edit the default launch arguments or environment for this agent.'
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
