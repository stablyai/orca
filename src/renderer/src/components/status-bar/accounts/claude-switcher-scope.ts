import type { AccountOwner } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ChatAccountAction } from './ProviderAccountChatButton'

/** Where the switcher lists and switches accounts; a WSL host's are this desktop's for its distro, chat or not. */
export function claudeSwitcherScope(
  chatAction: ChatAccountAction | undefined,
  owner: AccountOwner
): { runtimeTarget: RuntimeClientTarget; wslHostDistro: string | null; chatOnHost: boolean } {
  return owner.wslHostDistro
    ? { runtimeTarget: owner.target, wslHostDistro: owner.wslHostDistro, chatOnHost: false }
    : {
        runtimeTarget: chatAction?.target ?? owner.target,
        wslHostDistro: null,
        chatOnHost: chatAction !== undefined
      }
}
