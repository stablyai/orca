import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '@/components/LoadingSpinner'

export function OnboardingLanguageLoading(): React.JSX.Element {
  const t = useTranslate()
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
            {t('onboarding.language.settingsError', 'Could not load your settings.')}
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
            {t('onboarding.language.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoadingSpinner className="size-4" />
          {settings === null
            ? t('onboarding.language.loadingSettings', 'Loading settings…')
            : t('onboarding.language.loading', 'Loading language…')}
        </div>
      )}
    </div>
  )
}
