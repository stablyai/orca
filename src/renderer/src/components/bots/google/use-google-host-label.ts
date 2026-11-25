import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Where the Google sign-ins live: this computer, or the paired server Settings points at. */
export function useGoogleHostLabel(target: RuntimeClientTarget): string {
  const t = useTranslate()
  const name = useAppStore((state) =>
    target.kind === 'environment'
      ? (state.runtimeEnvironments.find((entry) => entry.id === target.environmentId)?.name ?? null)
      : null
  )
  return target.kind === 'local'
    ? t('bots.google.thisComputer', 'this computer')
    : (name ?? t('bots.google.thisServer', 'this server'))
}
