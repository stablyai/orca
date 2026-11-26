import React, { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { LazyAddConnectorDialog } from './lazy-bot-dialogs'
import { useConnectorSetup } from './ConnectorSetupDialogs'
import { takeConnectorSetup, useConnectorSetupWaiting } from './connector-setup-handoff'
import type { Bot } from '../../../../shared/bot-types'

/** Add a connector: `trigger` opens the connector list, and a pick continues in its setup dialog. */
export function AddConnectorButton({
  bot,
  trigger
}: {
  bot: Bot
  trigger: (open: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const setup = useConnectorSetup(bot)
  // A setup started in Settings for this bot continues here, on its page.
  const handedOff = useConnectorSetupWaiting(bot)
  // Settings' own button for the bot stays mounted a moment after the page opens; it never takes it.
  const inSettings = useAppStore((state) => state.activeView === 'settings')
  const { start } = setup
  useEffect(() => {
    const connector = handedOff && !inSettings ? takeConnectorSetup(bot) : null
    if (connector) {
      start(connector)
    }
  }, [handedOff, inSettings, bot, start])
  return (
    <>
      {trigger(() => setOpen(true))}
      {open ? (
        <LazyAddConnectorDialog
          bot={bot}
          open={open}
          onOpenChange={setOpen}
          onAdd={(connector) => {
            setOpen(false)
            setup.start(connector)
          }}
        />
      ) : null}
      {setup.dialogs}
    </>
  )
}
