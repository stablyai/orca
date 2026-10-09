import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
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
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import {
  NATIVE_CHAT_PERMISSION_MODE_ICONS,
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel,
  nativeChatPermissionPickerTitle,
  type NativeChatPermissionModePickerState
} from './native-chat-permission-mode-labels'

/** Icon and name; Full access reads in the warning colour wherever it is shown. */
function ModeName(props: { mode: AgentChatPermissionMode; truncate?: boolean }): React.JSX.Element {
  const Icon = NATIVE_CHAT_PERMISSION_MODE_ICONS[props.mode]
  const label = nativeChatPermissionModeLabel(props.mode)
  const body = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {props.truncate ? <span className="truncate">{label}</span> : <span>{label}</span>}
    </>
  )
  return props.mode === 'bypass' ? (
    <span className="flex min-w-0 items-center gap-1.5 text-status-warning">{body}</span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">{body}</span>
  )
}

function NativeChatPermissionModePickerInner({
  picker
}: {
  picker: NativeChatPermissionModePickerState | null | undefined
}): React.JSX.Element | null {
  if (!picker) {
    return null
  }
  const title = nativeChatPermissionPickerTitle()
  const currentLabel = nativeChatPermissionModeLabel(picker.current)
  // `shrink` overrides the button's shrink-0 so a narrow composer truncates the mode name.
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild disabled={picker.disabled}>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={translate(
                'components.native-chat.composer.pillAccessibleName',
                '{{value0}} {{value1}}',
                { value0: title, value1: currentLabel }
              )}
              className="max-w-40 min-w-0 shrink"
            >
              <ModeName mode={picker.current} truncate />
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {title}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-72">
        <DropdownMenuRadioGroup aria-label={title} value={picker.current}>
          {picker.supported.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              disabled={picker.pending}
              onSelect={() => {
                void picker.setMode(mode)
              }}
            >
              <div className="min-w-0 py-0.5">
                <ModeName mode={mode} />
                <div className="text-xs font-normal text-muted-foreground">
                  {nativeChatPermissionModeDescription(mode, picker.provider)}
                </div>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const NativeChatPermissionModePicker = memo(NativeChatPermissionModePickerInner)
