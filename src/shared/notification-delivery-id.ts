import type { NotificationDispatchRequest } from './notification-settings-types'

/** Producer IDs can repeat on cloned hosts; each transport owns its delivered copy. */
export function notificationDeliveryId(
  producerId: string,
  executionHost?: NotificationDispatchRequest['executionHost']
): string {
  return executionHost ? JSON.stringify([executionHost, producerId]) : producerId
}
