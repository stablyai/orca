// The plan a bot shows with `orca bot import plan`: what comes over from the old bot, what changes, and what
// stays behind, one checkbox per item that comes. The owner's answer goes back as an ordinary message.
import { useState } from 'react'
import { Check, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  botImportAnswer,
  type BotImportPlan,
  type BotImportPlanGroup
} from '../../../../shared/bots/bot-import-cards'
import { NativeChatCardAvatar, NativeChatCardFrame } from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'

function groupTitle(group: BotImportPlanGroup, app: string): string {
  switch (group) {
    case 'comes':
      return translate('components.native-chat.importPlan.comes', 'Comes over')
    case 'changed':
      return translate('components.native-chat.importPlan.changed', 'Comes over with changes')
    case 'already':
      return translate('components.native-chat.importPlan.already', 'Already here')
    case 'stays':
      return translate('components.native-chat.importPlan.stays', 'Stays in {{app}}', { app })
  }
}

const GROUP_ORDER: BotImportPlanGroup[] = ['comes', 'changed', 'already', 'stays']

export function NativeChatImportPlanCard({
  plan,
  messageId
}: {
  plan: BotImportPlan
  messageId: string
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const answering = useNativeChatOffer(plan.botId, messageId)
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set())
  const items = plan.items.map((item, index) => ({ ...item, index }))
  const bringable = items.filter((item) => item.group === 'comes' || item.group === 'changed')
  const sent = answering.sent
  const leftOut = sent
    ? new Set(
        bringable.filter((item) => !sent.includes(String(item.index))).map((item) => item.index)
      )
    : unticked
  const chosen = bringable.filter((item) => !leftOut.has(item.index))
  const toggle = (index: number, checked: boolean): void => {
    const next = new Set(leftOut)
    if (checked) {
      next.delete(index)
    } else {
      next.add(index)
    }
    setUnticked(next)
  }
  const asked =
    chosen.length === 1
      ? t('components.native-chat.importPlan.askedOne', 'Asked to import 1 item')
      : t('components.native-chat.importPlan.askedMany', 'Asked to import {{count}} items', {
          count: chosen.length
        })
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <Download className="size-4 text-muted-foreground" aria-hidden />
        </NativeChatCardAvatar>
      }
      heading={
        plan.again
          ? t('components.native-chat.importPlan.fromAgain', 'From {{app}}, again', {
              app: plan.app
            })
          : t('components.native-chat.importPlan.from', 'From {{app}}', { app: plan.app })
      }
      title={plan.name}
      footer={
        sent === null ? (
          <NativeChatOfferActions offer={answering}>
            <Button
              type="button"
              size="sm"
              disabled={chosen.length === 0}
              onClick={() =>
                answering.send(
                  botImportAnswer(plan, leftOut),
                  chosen.map((item) => String(item.index))
                )
              }
            >
              {chosen.length === 1
                ? t('components.native-chat.importPlan.importOne', 'Import 1 item')
                : t('components.native-chat.importPlan.importMany', 'Import {{count}} items', {
                    count: chosen.length
                  })}
            </Button>
          </NativeChatOfferActions>
        ) : undefined
      }
    >
      {GROUP_ORDER.map((group) => {
        const entries = items.filter((item) => item.group === group)
        if (entries.length === 0) {
          return null
        }
        const ticks = group === 'comes' || group === 'changed'
        return (
          <div key={group} className="mt-3">
            <p className="text-xs font-medium text-foreground">{groupTitle(group, plan.app)}</p>
            <div className="mt-1 divide-y divide-border">
              {entries.map((item) => (
                <label key={item.index} className="flex min-w-0 items-start gap-2.5 py-1.5">
                  {ticks ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={!leftOut.has(item.index)}
                      disabled={sent !== null}
                      onCheckedChange={(checked) => toggle(item.index, checked === true)}
                    />
                  ) : (
                    <span className="w-4 shrink-0 text-center text-muted-foreground" aria-hidden>
                      –
                    </span>
                  )}
                  <span
                    className={cn(
                      'min-w-0',
                      (!ticks || leftOut.has(item.index)) && 'text-muted-foreground'
                    )}
                  >
                    <span className="block text-sm">
                      <span className="font-medium">{item.what}</span>
                      {item.to ? <span className="text-muted-foreground"> → {item.to}</span> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">{item.why}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        {sent === null ? (
          t(
            'components.native-chat.importPlan.selected',
            '{{chosen}} of {{total}} selected · keys and logins are never copied',
            { chosen: chosen.length, total: bringable.length }
          )
        ) : (
          <>
            <Check className="size-3" aria-hidden />
            {asked}
          </>
        )}
      </p>
    </NativeChatCardFrame>
  )
}
