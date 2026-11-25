// @protected-copy scope=file
// The pill names the policy the agent runs under: a language pack must not reword what it says.
import { memo } from 'react'
import { ChevronDown, PencilRuler, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentPermissionSettingsSourceName } from '../../../../../../../shared/agent-launch/permissions/agent-permission-settings-source'
import { nativeChatPermissionSettingsHint } from './native-chat-permission-settings-hint'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import {
  NATIVE_CHAT_PERMISSION_MODE_ICONS,
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel,
  nativeChatPermissionPickerTitle
} from './native-chat-permission-mode-labels'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'
import { PermissionChoiceRadioItem } from './PermissionChoiceRadioItem'

export function NativeChatPermissionModeName(props: {
  mode: AgentChatPermissionMode
  truncate?: boolean
  label?: string
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = NATIVE_CHAT_PERMISSION_MODE_ICONS[props.mode]
  const label = props.label ?? nativeChatPermissionModeLabel(props.mode, t)
  const body = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {props.truncate ? (
        <span data-composer-label className="truncate">
          {label}
        </span>
      ) : (
        <span>{label}</span>
      )}
    </>
  )
  return props.mode === 'full-access' ? (
    <span className="flex min-w-0 items-center gap-1.5 text-status-warning">{body}</span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">{body}</span>
  )
}

export function NativeChatPermissionModeItems({
  modes,
  agent,
  disabled,
  onSelect
}: Pick<
  NativeChatPermissionModePickerProps,
  'modes' | 'agent' | 'disabled' | 'onSelect'
>): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {modes.map((mode) => (
        <PermissionChoiceRadioItem
          key={mode}
          value={mode}
          description={nativeChatPermissionModeDescription(mode, agent, t)}
          disabled={disabled}
          onSelect={() => onSelect(mode)}
        >
          <NativeChatPermissionModeName mode={mode} />
        </PermissionChoiceRadioItem>
      ))}
    </>
  )
}

export type NativeChatPermissionModePickerProps = {
  current: string | undefined
  /** The mode the agent reports running in when `current` is Own. */
  reported?: string
  modes: readonly AgentChatPermissionMode[]
  /** Whose descriptions to show; absent describes every agent's. */
  agent?: string | null
  disabled?: boolean
  currentLabel?: string
  /** `icon` is the composer pill: the mode's neutral icon alone, named by its tooltip. */
  appearance?: 'icon' | 'compact' | 'form'
  activeValue?: string
  onSelect: (mode: AgentChatPermissionMode) => void
  /** A first choice that sets no mode; shown as current while `current` is absent. */
  inherit?: { label: string; description: string; onSelect: () => void }
}

const INHERIT_VALUE = 'inherit'

function NativeChatPermissionModePickerInner({
  current,
  reported,
  modes,
  agent,
  disabled = false,
  onSelect,
  currentLabel,
  appearance = 'compact',
  inherit,
  activeValue
}: NativeChatPermissionModePickerProps): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const title = nativeChatPermissionPickerTitle(t)
  // Own shows the mode the agent reports when it has a translated name; until then it names the agent's settings.
  const own = current === 'own'
  const shown = own && isAgentChatPermissionMode(reported) ? reported : current
  const ownPlan = own && reported === 'plan'
  const settingsAgent = agentPermissionSettingsSourceName(agent)
  const ownSettings = t(
    'components.native-chat.composer.permissionAgentSettings',
    '{{agent}} settings',
    {
      agent: settingsAgent
    }
  )
  const selectedLabel = isAgentChatPermissionMode(shown)
    ? nativeChatPermissionModeLabel(shown, t)
    : ownPlan
      ? t('components.native-chat.composer.planMode', 'Plan')
      : own
        ? ownSettings
        : (currentLabel ?? inherit?.label ?? title)
  const Icon = ownPlan ? PencilRuler : Settings2
  const activeLabel = isAgentChatPermissionMode(activeValue)
    ? nativeChatPermissionModeLabel(activeValue, t)
    : activeValue === 'own'
      ? ownSettings
      : null
  const label = activeLabel
    ? t(
        'components.native-chat.composer.permissionAppliesNextMessage',
        '{{saved}} applies to your next message; currently using {{active}}',
        { saved: selectedLabel, active: activeLabel }
      )
    : selectedLabel
  // A reported mode is not an explicit pick, so its tooltip and name say where it comes from.
  const described =
    own && !activeLabel && (shown !== current || ownPlan)
      ? t(
          'components.native-chat.composer.permissionFromAgentSettings',
          '{{mode}}, from {{agent}} settings',
          { mode: label, agent: settingsAgent }
        )
      : label
  const hint = nativeChatPermissionSettingsHint({
    current,
    reported,
    deferred: activeLabel !== null
  })
  const hintLabel =
    hint === 'unnamed-report'
      ? t(
          'components.native-chat.composer.permissionAgentSettingsUnnamedHint',
          "Uses your {{agent}} permission settings. Orca can't show this mode.",
          { agent: settingsAgent }
        )
      : hint === 'settings'
        ? t(
            'components.native-chat.composer.permissionAgentSettingsUsedHint',
            'Uses your {{agent}} permission settings.',
            { agent: settingsAgent }
          )
        : null
  // The icon-only pill shows no name, so its tooltip always names the mode before any hint.
  const iconOnly = appearance === 'icon'
  const TriggerIcon = isAgentChatPermissionMode(shown)
    ? NATIVE_CHAT_PERMISSION_MODE_ICONS[shown]
    : Icon
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              type="button"
              variant={appearance === 'form' ? 'outline' : 'ghost'}
              size={iconOnly ? 'icon-sm' : 'xs'}
              aria-label={
                // An unrecognized value falls back to the title, which must not be said twice.
                described === title
                  ? title
                  : t(
                      'components.native-chat.composer.pillAccessibleName',
                      '{{value0}} {{value1}}',
                      {
                        value0: title,
                        value1: described
                      }
                    )
              }
              className={
                appearance === 'form'
                  ? 'h-8 w-64 max-w-full justify-between'
                  : iconOnly
                    ? 'size-7 pointer-coarse:size-11'
                    : 'min-w-0 shrink'
              }
            >
              {iconOnly ? (
                <TriggerIcon className="size-3.5 shrink-0" aria-hidden />
              ) : isAgentChatPermissionMode(shown) ? (
                <NativeChatPermissionModeName mode={shown} label={label} truncate />
              ) : (
                <>
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </>
              )}
              {iconOnly ? null : <ChevronDown className="size-3" />}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className="max-w-(--radix-tooltip-content-available-width)"
        >
          <span className="block max-w-72 break-words">
            {iconOnly ? described : (hintLabel ?? described)}
          </span>
          {iconOnly && hintLabel ? (
            <span className="block max-w-72 break-words opacity-70">{hintLabel}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        collisionPadding={8}
        className="w-72 max-w-(--radix-dropdown-menu-content-available-width)"
      >
        <DropdownMenuRadioGroup
          aria-label={title}
          value={current ?? (inherit ? INHERIT_VALUE : undefined)}
        >
          {inherit ? (
            <DropdownMenuRadioItem
              value={INHERIT_VALUE}
              disabled={disabled}
              onSelect={inherit.onSelect}
            >
              <div className="min-w-0 py-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Settings2 className="size-3.5 shrink-0" aria-hidden />
                  <span>{inherit.label}</span>
                </span>
                <div className="text-xs font-normal text-muted-foreground">
                  {inherit.description}
                </div>
              </div>
            </DropdownMenuRadioItem>
          ) : null}
          <NativeChatPermissionModeItems
            modes={modes}
            agent={agent}
            disabled={disabled}
            onSelect={onSelect}
          />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const NativeChatPermissionModePicker = memo(NativeChatPermissionModePickerInner)

const NO_PENDING_MARK = (): void => {}

/** The snapshot's permission descriptor, absent where the host states none; never locked by work. */
export function NativeChatComposerPermissionPicker({
  surface,
  snapshot,
  agent
}: {
  surface: SessionOptionsSurface | null
  snapshot: readonly SessionOptionDescriptor[]
  agent?: string
}): React.JSX.Element | null {
  const descriptor = snapshot.find((entry) => entry.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  const current = descriptor?.kind.type === 'select' ? descriptor.kind.currentValue : undefined
  if (!surface || !descriptor || descriptor.kind.type !== 'select') {
    return null
  }
  const modes = descriptor.kind.choices
    .map((choice) => choice.value)
    .filter(isAgentChatPermissionMode)
  if (modes.length === 0) {
    return null
  }
  return (
    <NativeChatPermissionModePicker
      current={current}
      reported={descriptor.kind.reportedValue}
      appearance="icon"
      modes={modes}
      activeValue={descriptor.valueSource === 'dispatched' ? descriptor.activeValue : undefined}
      agent={agent ?? descriptor.kind.settingsAgent ?? null}
      disabled={!descriptor.settable}
      onSelect={(mode) => {
        // The report can match a new explicit pick while the chat still follows agent settings.
        runSessionOptionSurfaceCall(mode, NO_PENDING_MARK, () =>
          surface.setOption(AGENT_CHAT_PERMISSION_MODE_OPTION_ID, mode)
        )
      }}
    />
  )
}
