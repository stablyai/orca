import React, { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { GOOGLE_SETUP_NEW_APP_RUNTIME_CAPABILITY } from '../../../../../shared/google/google-connect-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useGoogleHostLabel } from './use-google-host-label'
import type { useGoogleSignIn } from './use-google-sign-in'

/** An older paired server can't start a new-app setup: its start drops the flag or refuses the call. */
async function supportsGoogleNewApp(target: RuntimeClientTarget): Promise<boolean> {
  return (
    target.kind === 'local' ||
    runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GOOGLE_SETUP_NEW_APP_RUNTIME_CAPABILITY
    ).catch(() => false)
  )
}

/** Set up a new Google app on `target`'s host: this surface's sign-in stops and `start` runs, or, on
 *  a paired server too old to make one, an update notice shows instead. */
export function useGoogleNewApp(
  target: RuntimeClientTarget,
  signIn: Pick<ReturnType<typeof useGoogleSignIn>, 'cancel'>,
  start: () => void
): { newApp: () => void; updateNotice: React.ReactNode } {
  const t = useTranslate()
  const host = useGoogleHostLabel(target)
  const [needsUpdate, setNeedsUpdate] = useState(false)
  const newApp = (): void => {
    void supportsGoogleNewApp(target).then((supported) => {
      if (!supported) {
        setNeedsUpdate(true)
        return
      }
      signIn.cancel()
      start()
    })
  }
  return {
    newApp,
    updateNotice: needsUpdate ? (
      <p className="text-xs text-muted-foreground">
        {t(
          'bots.google.updateToSetUpNewApp',
          'Update Orca on {{host}} to set up a new Google app.',
          {
            host
          }
        )}
      </p>
    ) : null
  }
}
