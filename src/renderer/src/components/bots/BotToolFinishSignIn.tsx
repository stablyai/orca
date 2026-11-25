import { ExternalLink } from 'lucide-react'
import type { BotRef } from '@/lib/bot-hosts'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  botToolErrorMessage,
  finishBotToolSignIn,
  openBotToolSignInPage,
  useBotToolHostSignIn
} from './bot-tools-client'
import { SignInAddressPaste } from './SignInAddressPaste'

/** A tool sign-in finished in a browser that can't reach the bot's host: its address finishes it there. */
export function BotToolFinishSignIn({
  bot,
  name,
  openAgain = false
}: {
  bot: BotRef
  name: string
  /** Offers the host's page again here, for a row with no room for the button. */
  openAgain?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotToolHostSignIn(bot, name)
  const hosted = host?.paste === true
  const url = openAgain && hosted ? host.url : null
  return (
    <>
      <SignInAddressPaste
        hint={
          hosted
            ? t(
                'components.bots.toolSignIn.pasteLanded',
                'After you sign in, paste the address you landed on.'
              )
            : t(
                'components.bots.toolSignIn.pasteHint',
                'Signed in on another computer? Paste the address its browser ended on.'
              )
        }
        onFinish={(address) => finishBotToolSignIn(bot, name, address)}
        describeError={botToolErrorMessage}
      />
      {url ? (
        <Button variant="link" size="inlineText" onClick={() => openBotToolSignInPage(url)}>
          {t('bots.apps.openPageAgain', 'Open page again')}
          <ExternalLink />
        </Button>
      ) : null}
    </>
  )
}
