import { useState, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { MobileEmulatorAgentSetupGuide } from './MobileEmulatorAgentSetupGuide'
import { shouldShowMobileEmulatorAgentSetupGuide } from './mobile-emulator-agent-setup-visibility'
import { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'

type MobileEmulatorAgentSetupGuideLayerProps = {
  children: ReactNode
  isActive: boolean
  worktreeId: string
}

export function MobileEmulatorAgentSetupGuideLayer({
  children,
  isActive,
  worktreeId
}: MobileEmulatorAgentSetupGuideLayerProps): React.JSX.Element {
  const mobileEmulatorAgentSetupDismissed = useAppStore((s) => s.mobileEmulatorAgentSetupDismissed)
  const setup = useMobileEmulatorAgentSetupState(isActive)
  const [initialProbeComplete, setInitialProbeComplete] = useState(false)

  if (!initialProbeComplete && setup.statusReady) {
    setInitialProbeComplete(true)
  }

  const showGuide = shouldShowMobileEmulatorAgentSetupGuide({
    dismissed: mobileEmulatorAgentSetupDismissed,
    initialProbeComplete,
    isActive,
    statusReady: setup.statusReady
  })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
      {showGuide ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-[min(72%,28rem)] flex-col justify-end px-3 pb-3">
          {/* Why: a bottom scrim keeps the card readable without blurring the
              simulator preview, which read as a rendering glitch. */}
          <div
            aria-hidden="true"
            className="mobile-emulator-agent-setup-guide-scrim absolute inset-x-0 bottom-0 h-40"
          />
          <div className="pointer-events-auto relative">
            <MobileEmulatorAgentSetupGuide setup={setup} worktreeId={worktreeId} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
