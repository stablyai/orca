import { Loader2, Lock, LockOpen, ShieldCheck } from 'lucide-react'
import type { ClinePassCredentialsStatus } from '../../../../shared/clinepass-credentials'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'

type ClinePassCredentialStatusProps = {
  status: ClinePassCredentialsStatus | null
  loading: boolean
  loadFailed: boolean
}

export function ClinePassCredentialStatus({
  status,
  loading,
  loadFailed
}: ClinePassCredentialStatusProps): React.JSX.Element {
  const source = status?.source ?? 'none'
  const isStored = source === 'stored'
  const isEnvironment = source === 'environment'

  return (
    <div
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
        isStored || isEnvironment ? 'border-border/60' : 'border-border/40'
      )}
    >
      {loading ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            isStored || isEnvironment ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs font-medium">
          {loading
            ? translate(
                'auto.components.settings.ClinePassAccountsSection.f0fcb3c84e',
                'Checking API key…'
              )
            : loadFailed
              ? translate(
                  'auto.components.settings.ClinePassAccountsSection.139c527c90',
                  'Credential status unavailable'
                )
              : isStored
                ? translate(
                    'auto.components.settings.ClinePassAccountsSection.a59efe5917',
                    'API key saved in Orca'
                  )
                : isEnvironment
                  ? translate(
                      'auto.components.settings.ClinePassAccountsSection.76d85f70af',
                      'Configured by CLINE_API_KEY'
                    )
                  : translate(
                      'auto.components.settings.ClinePassAccountsSection.d6d08ab7ba',
                      'API key not configured'
                    )}
        </p>
        <p className="text-xs text-muted-foreground">
          {loadFailed
            ? translate(
                'auto.components.settings.ClinePassCredentialStatus.4df8f88808',
                'Orca could not check whether a Cline API key is configured. Try again.'
              )
            : isStored
              ? translate(
                  'auto.components.settings.ClinePassAccountsSection.20e3fe7fe6',
                  'Stored locally and sent only to api.cline.bot to read your ClinePass subscription quota.'
                )
              : isEnvironment
                ? translate(
                    'auto.components.settings.ClinePassAccountsSection.933597b6ca',
                    'CLINE_API_KEY configures Orca and cannot be cleared here. Save a key below to override it.'
                  )
                : translate(
                    'auto.components.settings.ClinePassAccountsSection.0571590443',
                    'Add a Cline API key to read your ClinePass subscription quota.'
                  )}
        </p>
      </div>
      {!loading && !loadFailed ? (
        <Badge
          variant={status?.configured ? 'secondary' : 'outline'}
          className="h-5 gap-1 rounded-full px-2 text-[10px] font-medium text-muted-foreground"
        >
          {status?.configured ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
          {isStored
            ? translate('auto.components.settings.ClinePassAccountsSection.fac44d3a91', 'Saved')
            : isEnvironment
              ? translate(
                  'auto.components.settings.ClinePassAccountsSection.b1866729fa',
                  'Environment'
                )
              : translate(
                  'auto.components.settings.ClinePassAccountsSection.d9ea8a4643',
                  'Not saved'
                )}
        </Badge>
      ) : null}
    </div>
  )
}
