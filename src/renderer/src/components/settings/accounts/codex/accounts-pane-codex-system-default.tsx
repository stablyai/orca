import type { Translate } from '@/i18n/use-translate'
import { selectCodexProviderAccount } from '@/runtime/provider-accounts/observations/runtime-provider-account-selection'
import { Badge } from '../../../ui/badge'
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
    <button
      type="button"
      onClick={() =>
        void runSystemDefaultSelect(
          systemDefaultLanes,
          accountOwner,
          runCodexAccountAction,
          selectCodexProviderAccount
        )
      }
      disabled={codexAction !== 'idle' || accountRuntimeUnavailable}
      className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        systemCodexNeedsSignIn
          ? 'border-destructive/50 bg-destructive/5'
          : systemCodexActive
            ? 'border-foreground/20 bg-accent/15'
            : 'border-border/70 hover:border-border hover:bg-accent/8'
      } disabled:cursor-default disabled:opacity-100`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {t('auto.components.settings.AccountsPane.f2a265f8c7', 'System default')}
          </span>
          {systemCodexActive ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
            >
              {t('auto.components.settings.AccountsPane.e74831fb6b', 'Active')}
            </Badge>
          ) : null}
          {systemCodexNeedsSignIn ? (
            <Badge
              variant="destructive"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none"
            >
              {t('auto.components.settings.AccountsPane.93c47b333a', 'Needs sign-in')}
            </Badge>
          ) : null}
        </div>
        <span
          className={`truncate text-[11px] ${
            systemCodexNeedsSignIn ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
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
      </div>
    </button>
  )
}
