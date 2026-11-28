import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { callAntigravityAccounts } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import {
  announceAntigravityAccountSwitch,
  announceAntigravityAccountSwitchFailure
} from '@/lib/provider-accounts/antigravity-account-switch-toasts'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { useStatusBarMenuFocusHandoff } from '../usage/ProviderDetailsMenu'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { providerChatAccountControl, type ChatAccountAction } from './ProviderAccountChatButton'

// Chats run on the host itself, never in a WSL distro.
const HOST: AntigravityAccountTarget = { runtime: 'host' }

/** The account a chat's next message runs on: the selection, which launches put back. */
function chatAccountId(state: AntigravityAccountState): string | null {
  return state.selectedAccountId ?? state.activeAccountId
}

/** Selects `accountId` for a chat once it may still move: the new rows, null when it may not, or
 *  undefined when the select failed (its toast says why). */
async function selectChatAccount(
  owner: ChatAccountAction['target'],
  chatAction: ChatAccountAction,
  accountId: string,
  t: ReturnType<typeof useTranslate>
): Promise<AntigravityAccountState | null | undefined> {
  try {
    if (!(await chatAction.canSwitch())) {
      toast.error(
        t(
          'components.native-chat.usageLimitActions.accountUnavailable',
          'This chat cannot move to another account. Hand it off to another agent instead.'
        )
      )
      return null
    }
    const next = await callAntigravityAccounts(owner, HOST, 'Select', accountId)
    announceAntigravityAccountSwitch(next, accountId)
    return next
  } catch (cause) {
    console.error('Failed to switch the Antigravity account from the chat:', cause)
    announceAntigravityAccountSwitchFailure(cause)
    return undefined
  }
}

/** A usage-limited Antigravity chat's switcher: the chat host's saved accounts; a pick moves the
 *  chat at its next message. Remount it (key) when the chat's host changes. */
export function AntigravityChatSwitcherMenu({
  chatAction
}: {
  chatAction: ChatAccountAction
}): React.JSX.Element | null {
  const t = useTranslate()
  const [owner] = useState(chatAction.target)
  const [state, setState] = useState<AntigravityAccountState | null>(null)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const mounted = useRef(true)
  const focusHandoff = useStatusBarMenuFocusHandoff()

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await callAntigravityAccounts(owner, HOST, 'List')
      if (mounted.current) {
        setState(next)
      }
    } catch (error) {
      console.error('Failed to load Antigravity accounts for the chat:', error)
    }
  }, [owner])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const select = async (accountId: string): Promise<void> => {
    if (switching) {
      return
    }
    setSwitching(true)
    const next = await selectChatAccount(owner, chatAction, accountId, t)
    if (mounted.current) {
      if (next) {
        setState(next)
      }
      setSwitching(false)
    }
    if (next === undefined) {
      void load()
    }
  }

  const accounts = state?.accounts ?? []
  const control = providerChatAccountControl(
    'antigravity',
    chatAction,
    state !== null,
    accounts.length,
    switching
  )
  if (!control || control.add) {
    return control?.button ?? null
  }
  const current = state ? chatAccountId(state) : null
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          focusHandoff.reset()
          // Another surface may have switched or saved an account since this chat last looked.
          void load()
        }
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>{control.button}</DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 max-w-[calc(100vw-1rem)]"
        onPointerDownOutside={focusHandoff.onPointerDownOutside}
        onCloseAutoFocus={focusHandoff.onCloseAutoFocus}
      >
        <DropdownMenuLabel>
          {t('auto.components.status.bar.AccountSwitchList.accounts', 'Accounts')}
        </DropdownMenuLabel>
        <div className="max-h-[min(300px,40vh)] overflow-y-auto pb-1 scrollbar-sleek">
          {accounts.map((account) => {
            const active = account.id === current
            return (
              <AccountSwitchRowItem
                key={account.id}
                label={account.email ?? t('accounts.antigravity.saved', 'Saved Google account')}
                active={active}
                disabled={switching || active}
                onSelect={(event) => {
                  event.preventDefault()
                  if (!active) {
                    void select(account.id)
                  }
                }}
              />
            )
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openAntigravitySignInSettings(owner)}>
          {t('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
