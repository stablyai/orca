import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type EmulatorSdkAvailability = {
  platform: string
  android: { sdkFound: boolean; sdkPath?: string; message: string }
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
}

type MobileEmulatorSdkStatusProps = {
  availability: EmulatorSdkAvailability
  configuredPath?: string | null
  onSetAndroidSdkPath: (path: string | null) => void | Promise<void>
}

const ANDROID_STUDIO_URL = 'https://developer.android.com/studio'

function StatusIcon({ ok }: { ok: boolean }): React.JSX.Element {
  return ok ? (
    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-success" />
  ) : (
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  )
}

// Shows which emulator toolchains Orca detected (Android SDK everywhere, iOS via
// Xcode on macOS) and lets users point Orca at an SDK in a custom location.
export function MobileEmulatorSdkStatus({
  availability,
  configuredPath,
  onSetAndroidSdkPath
}: MobileEmulatorSdkStatusProps): React.JSX.Element {
  // Guard against an older/remote runtime that predates the android block.
  const android = availability.android ?? { sdkFound: false, sdkPath: undefined, message: '' }
  const iosOk = Boolean(availability.simctl?.ok && availability.serveSim?.ok)
  const showIos = availability.platform === 'darwin'

  const handleLocate = async (): Promise<void> => {
    const picked = await window.api.shell.pickDirectory({
      defaultPath: android.sdkPath ?? configuredPath ?? undefined
    })
    if (picked) {
      await onSetAndroidSdkPath(picked)
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-4">
      <p className="text-sm font-semibold">
        {translate('auto.components.settings.MobileEmulatorSdkStatus.536026130e', 'Emulator SDKs')}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.MobileEmulatorSdkStatus.dde0ec1cd8',
          'Toolchains Orca uses to run emulators. Android works on any OS via the Android SDK; iOS Simulators need Xcode on macOS.'
        )}
      </p>

      <div className="mt-3 divide-y divide-border/40">
        <div className="flex items-start gap-3 py-3">
          <StatusIcon ok={android.sdkFound} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.MobileEmulatorSdkStatus.027cbf668a',
                  'Android SDK'
                )}
              </p>
              {android.sdkFound ? (
                <p className="break-all text-[11px] text-muted-foreground">
                  {configuredPath
                    ? translate(
                        'auto.components.settings.MobileEmulatorSdkStatus.f6d080d128',
                        'Using configured path '
                      )
                    : translate(
                        'auto.components.settings.MobileEmulatorSdkStatus.7fe4bd5907',
                        'Detected at '
                      )}
                  <code className="rounded bg-muted px-1 py-0.5">{android.sdkPath}</code>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {android.message ||
                    translate(
                      'auto.components.settings.MobileEmulatorSdkStatus.2784f0b22d',
                      'Not found. Install Android Studio, then create a Virtual Device.'
                    )}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {!android.sdkFound ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void window.api.shell.openUrl(ANDROID_STUDIO_URL)}
                >
                  {translate(
                    'auto.components.settings.MobileEmulatorSdkStatus.b94ff260e6',
                    'Download Android Studio'
                  )}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={() => void handleLocate()}>
                {translate(
                  'auto.components.settings.MobileEmulatorSdkStatus.18925b082d',
                  'Locate SDK folder…'
                )}
              </Button>
              {configuredPath ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void onSetAndroidSdkPath(null)}
                >
                  {translate(
                    'auto.components.settings.MobileEmulatorSdkStatus.8c52684db8',
                    'Clear'
                  )}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {showIos ? (
          <div className="flex items-start gap-3 py-3">
            <StatusIcon ok={iosOk} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.MobileEmulatorSdkStatus.76eb88b88e',
                  'iOS Simulator (Xcode)'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {iosOk
                  ? translate(
                      'auto.components.settings.MobileEmulatorSdkStatus.c6f3ea4f12',
                      'Ready'
                    )
                  : availability.simctl?.message ||
                    availability.serveSim?.message ||
                    translate(
                      'auto.components.settings.MobileEmulatorSdkStatus.e4f14b50d7',
                      'Install Xcode and add an iOS Simulator runtime.'
                    )}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
