// One of Orca's asks in a bot's Needs you group, in an item row's anatomy: a glyph for its kind, its
// title, what it asks. The row body opens where it was asked; hover or focus shows the same action
// named. Asks have no checkbox, age or status menu: answering happens where they were asked.
import { memo } from 'react'
import { CircleAlert, CircleHelp, Shield, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { openBotAutomation } from './bot-automation-open'
import { BotItemNumberColumn } from './items/BotItemNumberColumn'
import { BOT_ITEM_ROW_HOVER_ACTIONS } from './items/bot-item-row-hover-actions'
import { useNeedsYouRowCommit } from './use-needs-you-focus'

export type NeedKind = 'approval' | 'question' | 'sign-in' | 'access' | 'stopped'

const GLYPH = 'size-3 stroke-[2.25]'

function NeedGlyph({ kind }: { kind: NeedKind }): React.JSX.Element {
  switch (kind) {
    case 'approval':
      return <Shield className={cn(GLYPH, 'text-agent-question')} />
    case 'question':
      return <CircleHelp className={cn(GLYPH, 'text-agent-question')} />
    case 'sign-in':
      return <CircleAlert className={cn(GLYPH, 'text-destructive')} />
    case 'access':
      return <UserPlus className={cn(GLYPH, 'text-agent-question')} />
    case 'stopped':
      return <CircleAlert className={cn(GLYPH, 'text-muted-foreground')} />
  }
}

export type NeedAction = {
  label: string
  onOpen: () => void
  /** The label already names the row ("Open GitHub"), so it is the whole accessible name. */
  named?: boolean
}

export function NeedRow({
  kind,
  title,
  detail,
  worker = null,
  number = null,
  host = null,
  code = null,
  action
}: {
  kind: NeedKind
  title: string
  /** What it asks, after the worker's name; truncates first. */
  detail: string
  /** The worker that asks, named first when the row takes its item's title. */
  worker?: string | null
  /** The item's number when the row takes its item's title. */
  number?: number | null
  /** A paired computer's pill, before the second line. */
  host?: React.ReactNode
  /** The command or path an approval asks about, as its status or prompt reports it. */
  code?: string | null
  /** Where it opens; null when nowhere can, and `detail` says where it runs. */
  action: NeedAction | null
}): React.JSX.Element {
  const t = useTranslate()
  useNeedsYouRowCommit()
  const text = (
    <>
      <span className="block truncate text-[13px] leading-5 text-foreground">{title}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
        {host}
        <span className="min-w-0 truncate">
          {worker ? (
            <>
              <span className="text-foreground/85">
                {t('bots.needs.worker', 'Worker: {{name}}', { name: worker })}
              </span>
              {' · '}
            </>
          ) : null}
          {detail}
          {code ? (
            <>
              {' '}
              <code className="font-mono text-xs">{code}</code>
            </>
          ) : null}
        </span>
      </span>
    </>
  )
  const body =
    number === null ? (
      text
    ) : (
      <span className="flex min-w-0 items-start">
        <BotItemNumberColumn number={number} />
        <span className="min-w-0 flex-1">{text}</span>
      </span>
    )
  return (
    <div
      role="listitem"
      className="group/item relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent focus-within:bg-accent"
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <NeedGlyph kind={kind} />
      </span>
      {action ? (
        <button
          type="button"
          aria-label={action.named ? action.label : actionFor(t, action.label, title)}
          className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={action.onOpen}
        >
          {body}
        </button>
      ) : (
        <span className="min-w-0 flex-1">{body}</span>
      )}
      {action ? (
        // The body is the row's tab stop and name; this shows its action, fading over the title.
        <span aria-hidden className={BOT_ITEM_ROW_HOVER_ACTIONS}>
          <Button variant="ghost" size="xs" className="h-6" tabIndex={-1} onClick={action.onOpen}>
            {action.label}
          </Button>
        </span>
      ) : null}
    </div>
  )
}

/** A row's action named with its row, so a list of Open buttons reads apart. */
export function actionFor(t: Translate, action: string, title: string): string {
  return t('bots.needs.actionFor', '{{action}}: {{title}}', { action, title })
}

/** An automation a sign-in stopped: listed beside the connector needs as context, never counted. */
export const StoppedForSignInRow = memo(function StoppedForSignInRow({
  row
}: {
  row: BotAutomationRow
}): React.JSX.Element {
  const t = useTranslate()
  const { automation, latestRunId } = row
  return (
    <NeedRow
      kind="stopped"
      title={automation.name}
      detail={t('bots.needs.runSignIn', 'Couldn’t run until you sign in.')}
      action={{
        label: t('bots.needs.openRun', 'Open run'),
        onOpen: () => openBotAutomation(automation.id, latestRunId ?? null)
      }}
    />
  )
})
