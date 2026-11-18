/** Custody survives shell creation and never grants launch or retirement authority. */
export type MailWakeCustody = {
  id: string
  startedAt: number
  capturedAt: number
  attempt?: { ptyId: string; incarnationId: string; launchToken: string; startedAt: number }
}
