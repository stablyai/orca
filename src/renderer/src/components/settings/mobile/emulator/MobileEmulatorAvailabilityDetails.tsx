import { CheckCircle2, CircleAlert, FolderOpen, X } from 'lucide-react'
import type React from 'react'
import { toast } from 'sonner'
import { Button } from '../../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { emulatorMessageText } from '@/lib/simulator/launch/emulator-error-copy'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

type CodedMessage = { message?: string; messageCode?: unknown; messageParams?: unknown }

type ToolchainStatus = { sdkFound: boolean; sdkPath?: string } & CodedMessage

type EmulatorAvailability = {
  platform: string
  simctl: { ok: boolean } & CodedMessage
  serveSim: { ok: boolean } & CodedMessage
  android: ToolchainStatus
  harmonyos?: ToolchainStatus
}

type MobileEmulatorAvailabilityDetailsProps = {
  availability: EmulatorAvailability | null
  configuredPath?: string | null
  onSetAndroidSdkPath: (path: string | null) => void | Promise<void>
  configuredHarmonyPath?: string | null
  onSetHarmonySdkPath: (path: string | null) => void | Promise<void>
}

const ANDROID_STUDIO_URL = 'https://developer.android.com/studio'
const DEVECO_STUDIO_URL = 'https://developer.huawei.com/consumer/en/deveco-studio/'

function ToolchainStatusIcon({ ok }: { ok: boolean }): React.JSX.Element {
  return ok ? (
    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-success" />
  ) : (
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  )
}

function ToolchainStatusRow({
  ok,
  title,
  detail,
  actions
}: {
  ok: boolean
  title: string
  detail: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 py-2">
      <ToolchainStatusIcon ok={ok} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1 break-words text-xs text-muted-foreground">{detail}</div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-1">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const sdkPathActionClassName = 'h-6 px-2 text-muted-foreground hover:text-foreground'

export function MobileEmulatorAvailabilityDetails({
  availability,
  configuredPath,
  onSetAndroidSdkPath,
  configuredHarmonyPath,
  onSetHarmonySdkPath
}: MobileEmulatorAvailabilityDetailsProps): React.JSX.Element | null {
  const t = useTranslate()
  if (!availability) {
    return null
  }
  const android = availability.android ?? { sdkFound: false, sdkPath: undefined, message: '' }
  const harmony = availability.harmonyos ?? {
    sdkFound: false,
    sdkPath: undefined,
    message: ''
  }
  const iosOk = Boolean(availability.simctl?.ok && availability.serveSim?.ok)
  const showIos = availability.platform === 'darwin'

  const pickSdkPath = async (
    currentPath: string | undefined,
    onSetPath: (path: string | null) => void | Promise<void>,
    errorFallback: string
  ): Promise<void> => {
    try {
      const picked = await window.api.shell.pickDirectory({ defaultPath: currentPath })
      if (picked) {
        await onSetPath(picked)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : errorFallback)
    }
  }

  const clearSdkPath = async (
    onSetPath: (path: string | null) => void | Promise<void>,
    errorFallback: string
  ): Promise<void> => {
    try {
      await onSetPath(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : errorFallback)
    }
  }

  const androidLocateError = t(
    'auto.components.settings.MobileEmulatorSdkStatus.63fe73a1ea',
    'Could not update Android SDK folder.'
  )
  const harmonyLocateError = t(
    'auto.components.settings.MobileEmulatorSdkStatus.8e3f60b259',
    'Could not update HarmonyOS SDK folder.'
  )

  return (
    <div className="mt-3">
      <div className="divide-y divide-border/40 rounded-md border border-border/50 px-3">
        <ToolchainStatusRow
          ok={android.sdkFound}
          title={t('auto.components.settings.MobileEmulatorSdkStatus.027cbf668a', 'Android SDK')}
          detail={
            android.sdkFound ? (
              <>
                {configuredPath
                  ? t(
                      'auto.components.settings.MobileEmulatorSdkStatus.f6d080d128',
                      'Using configured path'
                    )
                  : t(
                      'auto.components.settings.MobileEmulatorSdkStatus.7fe4bd5907',
                      'Detected at'
                    )}{' '}
                <code className="rounded bg-muted px-1 py-0.5">{android.sdkPath}</code>
              </>
            ) : (
              emulatorMessageText(android) ||
              t(
                'auto.components.settings.MobileEmulatorSdkStatus.2784f0b22d',
                'Not found. Install Android Studio, then create a Virtual Device.'
              )
            )
          }
          actions={
            <>
              {!android.sdkFound ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={(event) => openAppHttpLink(ANDROID_STUDIO_URL, { event })}
                >
                  {t(
                    'auto.components.settings.MobileEmulatorSdkStatus.b94ff260e6',
                    'Download Android Studio'
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  void pickSdkPath(
                    android.sdkPath ?? configuredPath ?? undefined,
                    onSetAndroidSdkPath,
                    androidLocateError
                  )
                }
                className={sdkPathActionClassName}
              >
                <FolderOpen className="size-3" />
                {t(
                  'auto.components.settings.MobileEmulatorSdkStatus.18925b082d',
                  'Locate SDK folder'
                )}
              </Button>
              {configuredPath ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void clearSdkPath(onSetAndroidSdkPath, androidLocateError)}
                  className={sdkPathActionClassName}
                >
                  <X className="size-3" />
                  {t('auto.components.settings.MobileEmulatorSdkStatus.8c52684db8', 'Clear')}
                </Button>
              ) : null}
            </>
          }
        />

        <ToolchainStatusRow
          ok={harmony.sdkFound}
          title={t(
            'auto.components.settings.MobileEmulatorSdkStatus.4a1c9b5e7d',
            'HarmonyOS SDK (DevEco Studio)'
          )}
          detail={
            harmony.sdkFound ? (
              <>
                {configuredHarmonyPath
                  ? t(
                      'auto.components.settings.MobileEmulatorSdkStatus.f6d080d128',
                      'Using configured path'
                    )
                  : t(
                      'auto.components.settings.MobileEmulatorSdkStatus.7fe4bd5907',
                      'Detected at'
                    )}{' '}
                <code className="rounded bg-muted px-1 py-0.5">{harmony.sdkPath}</code>
              </>
            ) : (
              emulatorMessageText(harmony) ||
              t(
                'auto.components.settings.MobileEmulatorSdkStatus.4a1c9b5e7e',
                'Not found. Install DevEco Studio, then create an Emulator instance.'
              )
            )
          }
          actions={
            <>
              {!harmony.sdkFound ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={(event) => openAppHttpLink(DEVECO_STUDIO_URL, { event })}
                >
                  {t(
                    'auto.components.settings.MobileEmulatorSdkStatus.d5f2a7c041',
                    'Download DevEco Studio'
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  void pickSdkPath(
                    harmony.sdkPath ?? configuredHarmonyPath ?? undefined,
                    onSetHarmonySdkPath,
                    harmonyLocateError
                  )
                }
                className={sdkPathActionClassName}
              >
                <FolderOpen className="size-3" />
                {t(
                  'auto.components.settings.MobileEmulatorSdkStatus.18925b082d',
                  'Locate SDK folder'
                )}
              </Button>
              {configuredHarmonyPath ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void clearSdkPath(onSetHarmonySdkPath, harmonyLocateError)}
                  className={sdkPathActionClassName}
                >
                  <X className="size-3" />
                  {t('auto.components.settings.MobileEmulatorSdkStatus.8c52684db8', 'Clear')}
                </Button>
              ) : null}
            </>
          }
        />

        {showIos ? (
          <ToolchainStatusRow
            ok={iosOk}
            title={t(
              'auto.components.settings.MobileEmulatorSdkStatus.76eb88b88e',
              'iOS Simulator (Xcode)'
            )}
            detail={
              iosOk
                ? t('auto.components.settings.MobileEmulatorSdkStatus.c6f3ea4f12', 'Ready')
                : emulatorMessageText(
                    [availability.simctl, availability.serveSim].find((check) => check?.message) ??
                      {}
                  ) ||
                  t(
                    'auto.components.settings.MobileEmulatorSdkStatus.e4f14b50d7',
                    'Install Xcode and add an iOS Simulator runtime.'
                  )
            }
          />
        ) : null}
      </div>
    </div>
  )
}
