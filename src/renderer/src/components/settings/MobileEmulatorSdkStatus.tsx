import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Button } from '../ui/button'

type EmulatorSdkAvailability = {
  platform: string
  android: { sdkFound: boolean; sdkPath?: string; message: string }
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
}

const ANDROID_STUDIO_URL = 'https://developer.android.com/studio'

function StatusIcon({ ok }: { ok: boolean }): React.JSX.Element {
  return ok ? (
    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
  ) : (
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  )
}

// Shows which emulator toolchains Orca detected (Android SDK everywhere, iOS via
// Xcode on macOS) so users know what to install — mirrors the agent-control card.
export function MobileEmulatorSdkStatus({
  availability
}: {
  availability: EmulatorSdkAvailability
}): React.JSX.Element {
  const { android } = availability
  const iosOk = availability.simctl.ok && availability.serveSim.ok
  const showIos = availability.platform === 'darwin'

  return (
    <div className="rounded-2xl border border-border/60 bg-card/30 p-4">
      <p className="text-sm font-semibold">Emulator SDKs</p>
      <p className="text-xs text-muted-foreground">
        Toolchains Orca uses to run emulators. Android works on any OS via the Android SDK; iOS
        Simulators need Xcode on macOS.
      </p>

      <div className="mt-3 divide-y divide-border/40">
        <div className="flex items-start gap-3 py-3">
          <StatusIcon ok={android.sdkFound} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">Android SDK</p>
            {android.sdkFound ? (
              <p className="break-all text-[11px] text-muted-foreground">
                Detected at <code className="rounded bg-muted px-1 py-0.5">{android.sdkPath}</code>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {android.message ||
                  'Not found. Install Android Studio, then create a Virtual Device.'}
              </p>
            )}
          </div>
          {!android.sdkFound ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void window.api.shell.openUrl(ANDROID_STUDIO_URL)}
            >
              Download Android Studio
            </Button>
          ) : null}
        </div>

        {showIos ? (
          <div className="flex items-start gap-3 py-3">
            <StatusIcon ok={iosOk} />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">iOS Simulator (Xcode)</p>
              <p className="text-xs text-muted-foreground">
                {iosOk
                  ? 'Ready'
                  : availability.simctl.message ||
                    availability.serveSim.message ||
                    'Install Xcode and add an iOS Simulator runtime.'}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
