import { translate } from '@/i18n/i18n'

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/YjeGMQBA'
const ANDROID_APK_URL =
  'https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.27/app-release.apk'

export function MobileRelayBetaAvailability(): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/80">
        {translate('auto.components.settings.MobileRelayBetaAvailability.beta', 'Beta')}
      </span>
      <span aria-hidden="true">—</span>
      <span>
        {translate(
          'auto.components.settings.MobileRelayBetaAvailability.availability',
          'Available on'
        )}
      </span>
      <button
        type="button"
        className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => void window.api.shell.openUrl(TESTFLIGHT_URL)}
      >
        {translate('auto.components.settings.MobileRelayBetaAvailability.testFlight', 'TestFlight')}
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => void window.api.shell.openUrl(ANDROID_APK_URL)}
      >
        {translate(
          'auto.components.settings.MobileRelayBetaAvailability.androidApk',
          'Android APK'
        )}
      </button>
    </span>
  )
}
