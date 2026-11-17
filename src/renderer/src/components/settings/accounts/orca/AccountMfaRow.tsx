import { ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { useTranslate } from '@/i18n/use-translate'
import { useAccountMfa, type AccountMfaState } from './use-account-mfa'

export type AccountMfaRowViewProps = {
  state: AccountMfaState
  onOpenSetup: () => void
}

/** One state of the row; renders nothing until the first status read answers. */
export function AccountMfaRowView({
  state,
  onOpenSetup
}: AccountMfaRowViewProps): React.JSX.Element | null {
  const t = useTranslate()
  if (state.kind === 'unknown') {
    return null
  }
  const on = state.mfa === 'on'
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border/60 pt-5">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <ShieldCheck className="size-5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">
            {t('auto.components.settings.orcaAccount.mfa.title', 'Two-factor authentication')}
          </p>
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            {on
              ? t('auto.components.settings.orcaAccount.mfa.on', 'On')
              : t('auto.components.settings.orcaAccount.mfa.off', 'Off')}
          </Badge>
        </div>
        <p className="text-xs leading-5 text-muted-foreground" aria-live="polite">
          {on
            ? t(
                'auto.components.settings.orcaAccount.mfa.onDescription',
                'Signing in asks for a code from your authenticator app. Keep your backup codes somewhere safe.'
              )
            : t(
                'auto.components.settings.orcaAccount.mfa.offDescription',
                'Add an authenticator app so a stolen password is not enough to sign in. You get backup codes too.'
              )}
        </p>
      </div>
      {/* Opens the account page in the browser; the chevron copies that link instead. */}
      <OpenExternalSplitButton
        variant="outline"
        size="sm"
        link={state.setupUrl}
        onClick={onOpenSetup}
      >
        {on
          ? t('auto.components.settings.orcaAccount.mfa.manage', 'Manage in browser')
          : t('auto.components.settings.orcaAccount.mfa.setUp', 'Set up in browser')}
      </OpenExternalSplitButton>
    </div>
  )
}

/**
 * "Two-factor authentication" under the signed-in identity. Mount it only while signed in to Orca
 * Cloud.
 */
export function AccountMfaRow(): React.JSX.Element | null {
  const mfa = useAccountMfa()
  return <AccountMfaRowView state={mfa.state} onOpenSetup={mfa.openSetup} />
}
