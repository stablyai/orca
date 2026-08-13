import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getProviderAccountActiveIdForView,
  getProviderAccountRuntime
} from '@/components/settings/provider-account-visibility'
import {
  fetchProviderAccountsSnapshot,
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '../runtime/runtime-provider-accounts-client'

type ProviderAccountShortcutKind = 'claude' | 'codex'

const PROVIDER_LABEL: Record<ProviderAccountShortcutKind, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

/**
 * Switches the active host-runtime account of the provider at the given 1-based index and toasts the result.
 * WSL accounts are excluded — a numbered chord can't disambiguate a WSL distro; no-ops on out-of-range or already-active.
 */
export async function switchProviderAccountByIndex(
  kind: ProviderAccountShortcutKind,
  index: number
): Promise<void> {
  const settings = useAppStore.getState().settings
  try {
    const snapshot = await fetchProviderAccountsSnapshot(settings)
    const state = kind === 'claude' ? snapshot.claude : snapshot.codex
    const hostAccounts = state.accounts.filter(
      (account) => getProviderAccountRuntime(account).runtime === 'host'
    )
    const target = hostAccounts[index]
    if (!target) {
      return
    }

    const activeId = getProviderAccountActiveIdForView(state, { runtime: 'host' })
    if (activeId === target.id) {
      return
    }

    const selection = { accountId: target.id, runtime: 'host' as const }
    await (kind === 'claude'
      ? selectClaudeProviderAccount(settings, selection)
      : selectCodexProviderAccount(settings, selection))

    toast(
      translate(
        'auto.lib.provider.account.index.shortcut.switchedAccount',
        'Switched to {{provider}} account',
        { provider: PROVIDER_LABEL[kind] }
      ),
      { description: target.email }
    )
  } catch {
    toast.error(
      translate(
        'auto.lib.provider.account.index.shortcut.switchFailed',
        'Could not switch {{provider}} account',
        { provider: PROVIDER_LABEL[kind] }
      )
    )
  }
}
