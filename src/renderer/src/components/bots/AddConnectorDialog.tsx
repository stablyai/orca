// Add apps to <bot>: every app the bot can be given, in one wide dialog filtered by chips. Each app is
// listed once under its direct route; Composio's apps have a section of their own. Add opens the app's
// setup: Orca's own connector dialogs, the Composio account and sign-in, Webhooks, or an app by URL.
import React, { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotAppsCatalog, type BotAppsStep } from './apps/BotAppsCatalog'
import type { Bot } from '../../../../shared/bot-types'
import { GoogleAccountsStep, useGoogleSignedInFor } from './google/GoogleAccountsChoice'
import { type BotConnectorId, manageConnectors } from './bot-connector-descriptions'

export {
  connectorDescription,
  manageConnectors,
  type BotConnectorId
} from './bot-connector-descriptions'

export function AddConnectorDialog({
  bot,
  open,
  onOpenChange,
  onAdd
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (connector: BotConnectorId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [step, setStep] = useState<BotAppsStep | null>(null)
  // Google signed in on the bot's host: its Add continues here, on which accounts the bot may use.
  const [googleStep, setGoogleStep] = useState(false)
  const googleSignedIn = useGoogleSignedInFor(bot, open)
  const title = t('bots.apps.addAppsTitle', 'Add apps to {{bot}}', { bot: bot.name })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setStep(null)
          setGoogleStep(false)
        }
      }}
    >
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        data-step={step !== null || googleStep}
        className="flex h-175 max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-[min(57.5rem,calc(100vw-4rem))] data-[step=true]:h-auto data-[step=true]:sm:max-w-115"
      >
        {step !== null || googleStep ? (
          <DialogTitle className="sr-only">{title}</DialogTitle>
        ) : null}
        {open && googleStep ? (
          <GoogleAccountsStep
            bot={bot}
            onBack={() => setGoogleStep(false)}
            onClose={() => {
              onOpenChange(false)
              setGoogleStep(false)
            }}
          />
        ) : open ? (
          <BotAppsCatalog
            bot={bot}
            title={title}
            onOpenChange={(next) => {
              onOpenChange(next)
              if (!next) {
                setStep(null)
              }
            }}
            onManage={() => {
              onOpenChange(false)
              setStep(null)
              manageConnectors(bot)
            }}
            onAdd={(connector) =>
              connector === 'google' && googleSignedIn ? setGoogleStep(true) : onAdd(connector)
            }
            step={step}
            setStep={setStep}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
