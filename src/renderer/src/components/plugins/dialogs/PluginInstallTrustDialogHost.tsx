import { Suspense, useEffect, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import {
  settlePluginInstallTrust,
  usePluginInstallTrustStore
} from '@/store/plugins/installation/plugin-install-trust-request'

const PluginInstallTrustDialog = lazy(() =>
  import('./PluginInstallTrustDialog').then((module) => ({
    default: module.PluginInstallTrustDialog
  }))
)

/** Shows the install waiting for review, including language packs during onboarding. */
export function PluginInstallTrustDialogHost(): React.JSX.Element | null {
  const pending = usePluginInstallTrustStore((state) => state.pending)
  const [hasOpened, setHasOpened] = useState(false)
  if (pending && !hasOpened) {
    setHasOpened(true)
  }
  useEffect(() => () => settlePluginInstallTrust(false), [])
  if (!pending && !hasOpened) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <PluginInstallTrustDialog
        prompt={pending?.prompt ?? null}
        onCancel={() => settlePluginInstallTrust(false)}
        onConfirm={() => settlePluginInstallTrust(true)}
      />
    </Suspense>
  )
}
