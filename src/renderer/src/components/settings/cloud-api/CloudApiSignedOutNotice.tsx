import { CircleUserRound, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { OrcaSignInButton } from '../../OrcaSignInProgress'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudApiEmptyState } from './cloud-api-parts'

export function CloudApiSignedOutNotice({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup>
      <CloudApiEmptyState
        icon={CircleUserRound}
        title={t('auto.components.settings.cloudApi.signedOut.title', 'Sign in to Orca')}
        description={t(
          'auto.components.settings.cloudApi.signedOut.body',
          'Orca API keys and routines belong to your team. Sign in to manage them.'
        )}
        action={
          <div className="flex items-center gap-2">
            <OrcaSignInButton size="sm">
              {t('auto.components.settings.cloudApi.signedOut.signIn', 'Sign in to Orca')}
            </OrcaSignInButton>
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw />
              {t('auto.components.settings.cloudApi.retry', 'Try again')}
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  )
}
