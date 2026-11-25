// One of Orca's asks in a bot's Needs you group, in an item row's anatomy: a glyph for its kind and its
// title on one line; what it asks in the hover card. The row body opens where it was asked; hover or focus shows the same action
// named. Asks have no checkbox, age or status menu: answering happens where they were asked.
import { createContext, memo, useContext, useId } from 'react'
import { CircleAlert, CircleHelp, Shield, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import type { BotOnHost, BotRef } from '@/lib/bot-hosts'
import { openBotAutomation } from './bot-automation-open'
import { BotItemNumberColumn } from './items/BotItemNumberColumn'
import { BotRowHoverCard } from './BotPanelRow'
import { BOT_ITEM_ROW_HOVER_ACTIONS } from './items/bot-item-row-hover-actions'
import { useNeedsYouRowCommit } from './use-needs-you-focus'
import type { Bot } from '../../../../shared/bot-types'
import { BotItemRowFace } from './items/BotItemRowFace'

/** The bot an ask is from, in a group's merged Needs you; the rows under it show its face. */
export const NeedRowBot = createContext<Bot | null>(null)

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
  action,
  skip = null
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
  /** Settles the ask in place, before the action. */
  skip?: NeedAction | null
}): React.JSX.Element {
  const t = useTranslate()
  useNeedsYouRowCommit()
  const face = useContext(NeedRowBot)
  const descriptionId = useId()
  // One line like every row; who asks and what sits in the hover card and the description.
  const facts = (
    <>
      {worker ? (
        <>
          <span className="text-foreground/85">
            {t('bots.needs.worker', 'Worker: {{name}}', { name: worker })}
          </span>
          {detail ? ' · ' : null}
        </>
      ) : null}
      {detail}
      {code ? (
        <>
          {' '}
          <code className="font-mono text-xs">{code}</code>
        </>
      ) : null}
    </>
  )
  const card = (
    <>
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
        {host}
        <span className="min-w-0">{facts}</span>
      </p>
    </>
  )
  const text = <span className="block truncate text-[13px] leading-5 text-foreground">{title}</span>
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
      className="group/item relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent"
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        <NeedGlyph kind={kind} />
      </span>
      {face ? <BotItemRowFace bot={face} /> : null}
      <BotRowHoverCard card={card}>
        {action ? (
          <button
            type="button"
            aria-label={action.named ? action.label : actionFor(t, action.label, title)}
            aria-describedby={descriptionId}
            className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={action.onOpen}
          >
            {body}
          </button>
        ) : (
          <span className="min-w-0 flex-1">{body}</span>
        )}
      </BotRowHoverCard>
      <span id={descriptionId} hidden>
        {facts}
      </span>
      {action || skip ? (
        // The body is the row's tab stop and name; this shows its action, fading over the title.
        <span className={cn(BOT_ITEM_ROW_HOVER_ACTIONS, 'gap-0.5')}>
          {skip ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-6"
              aria-label={actionFor(t, skip.label, title)}
              onClick={skip.onOpen}
            >
              {skip.label}
            </Button>
          ) : null}
          {action ? (
            <Button
              variant="ghost"
              size="xs"
              className="h-6"
              aria-hidden
              tabIndex={-1}
              onClick={action.onOpen}
            >
              {action.label}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/** A row's action named with its row, so a list of Open buttons reads apart. */
export function actionFor(t: Translate, action: string, title: string): string {
  return t('bots.needs.actionFor', '{{action}}: {{title}}', { action, title })
}

/** An automation a sign-in stopped, stamped with its bot's host: a group lists several hosts' runs. */
export type StoppedForSignIn = BotAutomationRow & BotOnHost

/** An automation a sign-in stopped: listed beside the connector needs as context, never counted. */
export const StoppedForSignInRow = memo(function StoppedForSignInRow({
  bot,
  row
}: {
  bot: BotRef | null
  row: StoppedForSignIn
}): React.JSX.Element {
  const t = useTranslate()
  const { automation, latestRunId, hostId } = row
  return (
    <NeedRow
      kind="stopped"
      title={automation.name}
      detail={t('bots.needs.runSignIn', 'Couldn’t run until you sign in.')}
      action={{
        label: t('bots.needs.openRun', 'Open run'),
        onOpen: () =>
          openBotAutomation({
            bot,
            automationId: automation.id,
            runId: latestRunId ?? null,
            hostId,
            originRowKey: `stopped:${row.key}`
          })
      }}
    />
  )
})
