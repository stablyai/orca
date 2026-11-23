import React, { useState } from 'react'
import { FeishuIcon } from '../../icons/FeishuIcon'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import { BotFeishuSetup } from './BotFeishuSetup'
export function BotFeishuCard({
  bot,
  state
}: {
  bot: Bot
  state: FeishuLocalState
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <BotConnectorRowFrame
      icon={<FeishuIcon className="size-4" />}
      logo={<BotAppBrandLogo app={{ id: 'feishu-local', Icon: FeishuIcon }} />}
      name={t('bots.feishu.name', 'Feishu')}
      description={t('bots.feishu.line', 'Private messages through Feishu CLI on this host')}
      status={null}
    >
      <p className="text-xs text-muted-foreground">{state.profile}</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t('bots.feishu.settings', 'Connection settings')}
      </Button>
      {open ? <BotFeishuSetup bot={bot} onClose={() => setOpen(false)} /> : null}
    </BotConnectorRowFrame>
  )
}
