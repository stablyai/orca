import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { getTranslatedExecutionHostLabel } from '@/runtime/hosts/display/execution-host-label'
import type { Bot } from '../../../../shared/bot-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { BotAvatar } from './BotAvatar'
import { BotPickRow } from './BotPickList'
import { useBotHostLabel } from './use-bot-host-label'

export function BotGroupMemberRow({
  bot,
  purpose,
  on,
  pop,
  disabled,
  showHost,
  compact,
  describedBy,
  onToggle
}: {
  bot: Bot
  purpose: string | null
  on: boolean
  pop: boolean
  disabled: boolean
  /** Bots span more than one computer: say which one this is. */
  showHost: boolean
  compact: boolean
  /** Why it can't be picked. */
  describedBy?: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <BotPickRow
      role="checkbox"
      aria-checked={on}
      disabled={disabled}
      aria-describedby={describedBy}
      // A pointer pick leaves focus in the name field, so its Tab suggestion still works.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      picture={
        <BotAvatar
          bot={bot}
          className={compact ? 'size-6 rounded-md text-xs' : 'size-7 rounded-lg text-sm'}
        />
      }
      name={bot.name}
      detail={purpose}
      on={on}
      pop={pop}
      indicator={compact ? 'checkbox' : 'badge'}
      trailing={showHost ? <MemberHost hostId={bot.hostId} /> : null}
    />
  )
}

function useMemberHost(hostId: ExecutionHostId): string {
  const t = useTranslate()
  const remote = useBotHostLabel(hostId)
  // Matches the dialog's own words ("…at least one bot on this computer").
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? t('bots.groups.thisComputer', 'This computer')
    : (remote ?? getTranslatedExecutionHostLabel(hostId, t))
}

function MemberHost({ hostId }: { hostId: ExecutionHostId }): React.JSX.Element {
  const host = useMemberHost(hostId)
  return <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{host}</span>
}

export function BotGroupMemberHostGroup({
  hostId,
  children
}: {
  hostId: ExecutionHostId
  children: React.ReactNode
}): React.JSX.Element {
  const host = useMemberHost(hostId)
  const labelId = useId()
  return (
    <div role="group" aria-labelledby={labelId} className="shrink-0">
      <div
        id={labelId}
        className="truncate px-2 pt-1 pb-0.5 text-2xs font-medium text-muted-foreground"
      >
        {host}
      </div>
      {children}
    </div>
  )
}
