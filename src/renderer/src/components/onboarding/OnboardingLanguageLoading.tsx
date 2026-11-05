import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '@/components/LoadingSpinner'

export function OnboardingLanguageLoading(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const fetchSettings = useAppStore((state) => state.fetchSettings)
  const [retrying, setRetrying] = useState(false)
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background text-foreground"
      aria-busy={settings !== null || retrying}
    >
      {settings === null && !retrying ? (
        <div className="space-y-3 text-center">
          <p className="text-sm">
            {translate('onboarding.language.settingsError', 'Could not load your settings.')}
          </p>
          <Button
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              void fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true }).finally(() =>
                setRetrying(false)
              )
            }}
          >
            {translate('onboarding.language.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoadingSpinner className="size-4" />
          {settings === null
            ? translate('onboarding.language.loadingSettings', 'Loading settings…')
            : translate('onboarding.language.loading', 'Loading language…')}
        </div>
      )}
    </div>
  )
}
