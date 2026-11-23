import { useTranslate } from '@/i18n/use-translate'
import type React from 'react'
import { useMemo } from 'react'
import { ProviderDetailsMenu } from '../usage/ProviderDetailsMenu'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { useAppStore } from '../../../store/index'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'
import { getAccountOwnerKey } from './owner-account-rows'
import {
  useAccountOwnerUsage,
  type OwnerUsageRateLimits
} from '../usage/use-owner-usage-rate-limits'

export type ClaudeSwitcherMenuProps = {
  claude: ProviderRateLimits | null
  iconOnly?: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
} & (
  | { chatAction: ChatAccountAction; ownerUsage?: never }
  /** The status bar's owner observation: rows list that owner's accounts and readings. */
  | { ownerUsage: OwnerUsageRateLimits; chatAction?: never }
)

export function ClaudeSwitcherMenu(props: ClaudeSwitcherMenuProps): React.JSX.Element | null {
  const t = useTranslate()
  if (props.chatAction) {
    return <ChatClaudeSwitcherMenu {...props} chatAction={props.chatAction} />
  }
  const owner = props.ownerUsage.owner
  if (!owner) {
    return (
      <ProviderDetailsMenu
        provider={props.claude}
        iconOnly={props.iconOnly}
        asSubmenu={props.asSubmenu}
        triggerContent={props.triggerContent}
        ariaLabel={t(
          'auto.components.status.bar.StatusBar.3dd7ddfae1',
          'Open Claude details and account switcher'
        )}
      />
    )
  }
  return (
    <ClaudeSwitcherForOwner
      {...props}
      key={getAccountOwnerKey(owner)}
      owner={owner}
      ownerUsage={props.ownerUsage}
    />
  )
}

/** A chat's rows belong to the chat's host, read through the same owner observation as the bar. */
function ChatClaudeSwitcherMenu(
  props: ClaudeSwitcherMenuProps & { chatAction: ChatAccountAction }
): React.JSX.Element | null {
  const target = props.chatAction.target
  const owner = useMemo<AccountOwner>(() => ({ target, wslHostDistro: null }), [target])
  const ownerUsage = useAccountOwnerUsage(
    owner,
    useAppStore((s) => s.rateLimits)
  )
  return (
    <ClaudeSwitcherForOwner
      {...props}
      key={getAccountOwnerKey(owner)}
      owner={owner}
      ownerUsage={ownerUsage}
    />
  )
}
