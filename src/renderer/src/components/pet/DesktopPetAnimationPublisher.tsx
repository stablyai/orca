import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { selectPetAgentAnimation } from './pet-agent-state'

/** Runs in the main window only: the detached pet window has no agent store, so publish the
 *  agent-derived animation to main, which relays it. Mounted only while the pet is detached. */
export function useDesktopPetAnimationPublisher(): void {
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  // Why: a pet window that just mounted asks for a replay; bumping this republishes even when
  // the animation is unchanged, so a reopened window is never left on the wrong state.
  const [republishEpoch, setRepublishEpoch] = useState(0)
  const lastPublishedRef = useRef<string | null>(null)

  // Re-render when the freshness scheduler ticks so stale live states stop driving the pet.
  void agentStatusEpoch

  useEffect(
    () =>
      window.api.desktopPet.onAnimationRequested(() => {
        lastPublishedRef.current = null
        setRepublishEpoch((epoch) => epoch + 1)
      }),
    []
  )

  useEffect(() => {
    void republishEpoch
    const animation = selectPetAgentAnimation({
      entries: Object.values(agentStatusByPaneKey),
      retainedCount: Object.keys(retainedAgentsByPaneKey).length,
      now: Date.now(),
      staleAfterMs: AGENT_STATUS_STALE_AFTER_MS
    })
    if (animation === lastPublishedRef.current) {
      return
    }
    lastPublishedRef.current = animation
    window.api.desktopPet.publishAnimation(animation).catch(console.error)
  }, [agentStatusByPaneKey, agentStatusEpoch, retainedAgentsByPaneKey, republishEpoch])
}

/** Renders nothing; mounted in the main window while the pet is detached. */
export function DesktopPetAnimationPublisher(): null {
  useDesktopPetAnimationPublisher()
  return null
}
