import { ArrowRightLeft, Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatUsageLimitAccountOffer } from './use-native-chat-usage-limit-account-offer'

/** The usage-limit notice's way past the limit: another account with room, or adding one. */
export function NativeChatUsageLimitAccountAction({
  offer
}: {
  offer: NativeChatUsageLimitAccountOffer
}): React.JSX.Element {
  if (offer.kind === 'add') {
    return (
      <Button type="button" variant="outline" size="xs" onClick={offer.addAccount}>
        <UserPlus />
        {translate('components.native-chat.usageLimitAccount.add', 'Add account')}
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="max-w-full"
      disabled={offer.switching}
      onClick={offer.switchAndContinue}
    >
      {offer.switching ? <Loader2 className="animate-spin" /> : <ArrowRightLeft />}
      <span className="truncate">
        {translate(
          'components.native-chat.usageLimitAccount.switch',
          'Switch to {{account}} · {{percent}}% left and continue',
          { account: offer.account, percent: offer.percentLeft }
        )}
      </span>
    </Button>
  )
}
