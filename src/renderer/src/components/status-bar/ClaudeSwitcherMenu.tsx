import type React from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import { useAppStore } from '../../store'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { useActiveAccountOwner } from '@/runtime/use-worktree-runtime-target'
import { ClaudeSwitcherForOwner } from './ClaudeSwitcherForOwner'

export type ClaudeSwitcherMenuProps = {
  claude: ProviderRateLimits | null
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
  chatAction?: ChatAccountAction
}

export function ClaudeSwitcherMenu(props: ClaudeSwitcherMenuProps): React.JSX.Element | null {
  return props.chatAction ? (
    <ClaudeSwitcherForOwner
      {...props}
      owner={{ target: props.chatAction.target, wslHostDistro: null }}
    />
  ) : (
    <FocusedClaudeSwitcher {...props} />
  )
}

function FocusedClaudeSwitcher(props: ClaudeSwitcherMenuProps): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const owner = useActiveAccountOwner(defaultScopeHost(settings))
  return <ClaudeSwitcherForOwner {...props} owner={owner} />
}
