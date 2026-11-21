import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ChatForkRecapScope } from '../../../../../../../shared/agent-session/conversation-context/chat-fork-recap'
import type { ChatForkSurface } from '../../../../../../../shared/native-chat/chat-fork-path'
import type { NativeChatForkRoute } from './native-chat-fork-window-choices'

function isSurface(value: string): value is ChatForkSurface {
  return value === 'chat' || value === 'terminal'
}

function isRecapScope(value: string): value is ChatForkRecapScope {
  return value === 'history' || value === 'current'
}

/** Open as (chat or terminal) and, for a recap, how much of the chat it hands over. */
export function NativeChatForkWindowOpenAsFields(props: {
  id: string
  busy: boolean
  agent: TuiAgent
  surfaces: Readonly<Record<ChatForkSurface, boolean>>
  openAs: ChatForkSurface | null
  onOpenAsChange: (surface: ChatForkSurface) => void
  route: NativeChatForkRoute
  recapScope: ChatForkRecapScope
  onRecapScopeChange: (scope: ChatForkRecapScope) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { id, busy } = props
  const agent = getAgentLabel(props.agent)
  const surfaceLabel: Record<ChatForkSurface, string> = {
    chat: t('components.native-chat.fork.window.openAsChat', 'Chat'),
    terminal: t('components.native-chat.fork.window.openAsTerminal', 'Terminal (CLI)')
  }
  const unavailable: Record<ChatForkSurface, string> = {
    chat: t(
      'components.native-chat.fork.window.chatUnavailable',
      '{{agent}} doesn’t open as a chat on this host.',
      { agent }
    ),
    terminal: t(
      'components.native-chat.fork.window.terminalUnavailable',
      '{{agent}}’s CLI wasn’t found on this host.',
      { agent }
    )
  }
  const blocked = (['chat', 'terminal'] as const).filter((surface) => !props.surfaces[surface])
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-open-as`}>
          {t('components.native-chat.fork.window.openAsLabel', 'Open as')}
        </Label>
        <Select
          value={props.openAs ?? ''}
          disabled={busy || props.openAs === null}
          onValueChange={(value) => {
            if (isSurface(value) && props.surfaces[value]) {
              props.onOpenAsChange(value)
            }
          }}
        >
          <SelectTrigger id={`${id}-open-as`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['chat', 'terminal'] as const).map((surface) => (
              <SelectItem key={surface} value={surface} disabled={!props.surfaces[surface]}>
                {surfaceLabel[surface]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {blocked.map((surface) => (
          <p key={surface} className="text-xs text-muted-foreground">
            {unavailable[surface]}
          </p>
        ))}
      </div>
      {props.route === 'recap' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-context`}>
            {t('components.native-chat.fork.window.contextLabel', 'Context')}
          </Label>
          <Select
            value={props.recapScope}
            disabled={busy}
            onValueChange={(value) => {
              if (isRecapScope(value)) {
                props.onRecapScopeChange(value)
              }
            }}
          >
            <SelectTrigger id={`${id}-context`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="history">
                {t('components.native-chat.fork.window.contextHistory', 'Full history up to here')}
              </SelectItem>
              <SelectItem value="current">
                {t(
                  'components.native-chat.fork.window.contextCurrent',
                  'Current context (since the last compact or clear)'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </>
  )
}
