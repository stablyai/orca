import { createAgentHookNotificationRetirement } from './agent-hook-notification-retirement'

export function createRendererHookRetirement(getPtyId: () => string | null) {
  return createAgentHookNotificationRetirement(getPtyId, (alerts) => {
    void window.api?.notifications
      ?.dismiss?.([], [], undefined, alerts)
      .catch((error: unknown) =>
        console.warn('[agent-hook-completion] turn retirement failed', error)
      )
  })
}
