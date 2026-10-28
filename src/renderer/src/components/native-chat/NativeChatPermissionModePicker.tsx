import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../shared/agent-chat-permission-mode'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import {
  NATIVE_CHAT_PERMISSION_MODE_ICONS,
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel,
  nativeChatPermissionPickerTitle
} from './native-chat-permission-mode-labels'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'

export function NativeChatPermissionModeName(props: {
  mode: AgentChatPermissionMode
  truncate?: boolean
}): React.JSX.Element {
  const Icon = NATIVE_CHAT_PERMISSION_MODE_ICONS[props.mode]
  const label = nativeChatPermissionModeLabel(props.mode)
  const body = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {props.truncate ? <span className="truncate">{label}</span> : <span>{label}</span>}
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
  return (
    <>
      {modes.map((mode) => (
        <DropdownMenuRadioItem
          key={mode}
          value={mode}
          disabled={disabled}
          onSelect={() => onSelect(mode)}
        >
          <div className="min-w-0 py-0.5">
            <NativeChatPermissionModeName mode={mode} />
            <div className="text-xs font-normal text-muted-foreground">
              {nativeChatPermissionModeDescription(mode, agent)}
            </div>
          </div>
        </DropdownMenuRadioItem>
      ))}
    </>
  )
}

export type NativeChatPermissionModePickerProps = {
  current: string | undefined
  modes: readonly AgentChatPermissionMode[]
  /** Whose descriptions to show; absent describes every agent's. */
  agent?: string | null
  disabled?: boolean
  currentLabel?: string
  onSelect: (mode: AgentChatPermissionMode) => void
}

function NativeChatPermissionModePickerInner({
  current,
  modes,
  agent,
  disabled = false,
  onSelect,
  currentLabel
}: NativeChatPermissionModePickerProps): React.JSX.Element {
  useTranslation()
  const title = nativeChatPermissionPickerTitle()
  const label = isAgentChatPermissionMode(current)
    ? nativeChatPermissionModeLabel(current)
    : (currentLabel ?? title)
  // `shrink` overrides the button's shrink-0 so a narrow composer truncates the mode name.
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={translate(
                'components.native-chat.composer.pillAccessibleName',
                '{{value0}} {{value1}}',
                { value0: title, value1: label }
              )}
              className="max-w-40 min-w-0 shrink"
            >
              {isAgentChatPermissionMode(current) ? (
                <NativeChatPermissionModeName mode={current} truncate />
              ) : (
                <>
                  <Settings2 className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </>
              )}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {title}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-72">
        <DropdownMenuRadioGroup aria-label={title} value={current}>
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
      modes={modes}
      currentLabel={descriptor.description}
      agent={agent ?? null}
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
