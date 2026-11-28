import type { Translate } from '@/i18n/use-translate'
import { selectCodexProviderAccount } from '@/runtime/provider-accounts/observations/runtime-provider-account-selection'
import { AccountCard } from '../account-card'
import { getCodexSystemDefaultSubtitle } from '../scope/accounts-pane-runtime'
import {
  clearsHiddenWslLanes,
  getSystemDefaultLanes,
  runSystemDefaultSelect,
  systemDefaultCandidates
} from '../scope/system-default-lanes'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

export function renderCodexSystemDefaultButton(
  model: AccountsPaneSectionModel,
  t: Translate
): React.JSX.Element {
  const {
    accountOwner,
    accountRuntime,
    accountRuntimeSentenceLabel,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    codexAccounts,
    codexAction,
    isRemoteAccountScope,
    runCodexAccountAction,
    systemCodexActive,
    systemCodexIdentity,
    systemCodexMissingSignIn,
    systemCodexNeedsSignIn,
    visibleCodexAccounts
  } = model
  const systemDefaultLanes = getSystemDefaultLanes(
    accountRuntime,
    systemDefaultCandidates(codexAccounts.accounts, visibleCodexAccounts, accountVisibilityOptions),
    codexAccounts,
    isRemoteAccountScope
  )
  return (
    <AccountCard
      title={t('auto.components.settings.AccountsPane.f2a265f8c7', 'System default')}
      active={systemCodexActive}
      attention={
        systemCodexNeedsSignIn &&
        t('auto.components.settings.AccountsPane.93c47b333a', 'Needs sign-in')
      }
      detail={
        <span className="truncate">
          {systemCodexNeedsSignIn
            ? systemCodexMissingSignIn
              ? t(
                  'auto.components.settings.AccountsPane.codexSystemDefaultNeedsSignIn',
                  'No Codex sign-in was found for {{value0}}.',
                  { value0: accountRuntimeSentenceLabel }
                )
              : t(
                  'auto.components.settings.AccountsPane.fd62f37c24',
                  'Codex reported this {{value0}} login is out of date.',
                  { value0: accountRuntimeSentenceLabel }
                )
            : getCodexSystemDefaultSubtitle(
                systemCodexIdentity,
                accountRuntimeSentenceLabel,
                t,
                clearsHiddenWslLanes(systemDefaultLanes)
              )}
        </span>
      }
      onSelect={() =>
        void runSystemDefaultSelect(
          systemDefaultLanes,
          accountOwner,
          runCodexAccountAction,
          selectCodexProviderAccount
        )
      }
      selectDisabled={codexAction !== 'idle' || accountRuntimeUnavailable}
    />
  )
}
