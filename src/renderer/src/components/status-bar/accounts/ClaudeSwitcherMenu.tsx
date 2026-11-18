import type React from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'
import { getAccountOwnerKey } from './owner-account-rows'
import type { OwnerUsageRateLimits } from '../usage/use-owner-usage-rate-limits'

export type ClaudeSwitcherMenuProps = {
  claude: ProviderRateLimits | null
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
} & (
  | { chatAction: ChatAccountAction; ownerUsage?: never }
  /** The status bar's owner observation: rows list that owner's accounts and readings. */
  | { ownerUsage: OwnerUsageRateLimits; chatAction?: never }
)

export function ClaudeSwitcherMenu(props: ClaudeSwitcherMenuProps): React.JSX.Element | null {
  const owner = props.chatAction
    ? { target: props.chatAction.target, wslHostDistro: null }
    : props.ownerUsage.owner
  return <ClaudeSwitcherForOwner {...props} key={getAccountOwnerKey(owner)} owner={owner} />
}
