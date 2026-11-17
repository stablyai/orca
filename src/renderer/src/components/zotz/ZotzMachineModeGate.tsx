import { Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import {
  isZotzMachineModeHost,
  onZotzMachineModeWizardOpen
} from './zotz-machine-mode-wizard-event'

const ZotzMachineModeWizard = lazy(() => import('./ZotzMachineModeWizard'))

/** Shows the machine-mode wizard while the mode is unset (after onboarding) or when Settings asks. */
export function ZotzMachineModeGate({
  onboardingVisible
}: {
  onboardingVisible: boolean
}): React.JSX.Element | null {
  const mode = useAppStore((state) => state.settings?.zotzMachineMode ?? null)
  const [requested, setRequested] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => onZotzMachineModeWizardOpen(() => setRequested(true)), [])

  const firstRun =
    window.api.zotzNode.autoShowFirstRun === true &&
    mode === 'unset' &&
    !dismissed &&
    !onboardingVisible
  if (!isZotzMachineModeHost() || (!firstRun && !requested)) {
    return null
  }
  const close = (): void => {
    setRequested(false)
    setDismissed(true)
  }
  return createPortal(
    <div className="fixed inset-0 z-40 bg-background">
      <Suspense fallback={null}>
        <ZotzMachineModeWizard onClose={close} onKeepOpen={() => setRequested(true)} />
      </Suspense>
    </div>,
    document.body
  )
}
