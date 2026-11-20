// Mirror of cloud/packages/connector-contract/src/cliq-messages.ts for the desktop's reads; a data
// center this Orca doesn't know reads as a plain string, so a newer cloud's never voids an answer.
import * as z from 'zod'

/** A cloud without the cliq routes answers a bare 404; the desktop reads it as Cliq not offered yet. */
export const BOT_CLIQ_OFF = 'cliq_off'

const CLIQ_WEB_HOSTS: Record<string, string> = {
  us: 'cliq.zoho.com',
  eu: 'cliq.zoho.eu',
  in: 'cliq.zoho.in',
  au: 'cliq.zoho.com.au',
  jp: 'cliq.zoho.jp',
  ca: 'cliq.zohocloud.ca',
  sa: 'cliq.zoho.sa',
  uk: 'cliq.zoho.uk'
}

/** Where people open Cliq for an organization in this data center. */
export function cliqWebUrl(dataCenter: string): string {
  return `https://${CLIQ_WEB_HOSTS[dataCenter] ?? CLIQ_WEB_HOSTS.us}`
}

const CliqOrg = {
  orgId: z.string().min(1),
  name: z.string(),
  dataCenter: z.string().min(1)
}

export const ConnectorCliqState = z.object({
  orgs: z.array(
    z.object({
      ...CliqOrg,
      userId: z.string().min(1),
      userName: z.string(),
      expired: z.literal(true).optional().catch(undefined)
    })
  )
})
export type ConnectorCliqState = z.infer<typeof ConnectorCliqState>

export const ConnectorBotCliqState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_created') }),
  z.object({
    state: z.literal('installed'),
    orgId: z.string(),
    cliqBotId: z.string(),
    uniqueName: z.string(),
    installerUserId: z.string(),
    dataCenter: z.string(),
    orgName: z.string().optional(),
    installerName: z.string().optional(),
    updateNeeded: z.literal(true).optional().catch(undefined)
  }),
  z.object({
    state: z.literal('broken'),
    orgId: z.string(),
    // grant_expired: sign in again. bot_deleted: set up again. Any other reads as set up again.
    reason: z.string()
  })
])
export type ConnectorBotCliqState = z.infer<typeof ConnectorBotCliqState>

export const ConnectorBotCliqStateResponse = ConnectorBotCliqState.and(
  z.object({ orgs: z.array(ConnectorBotCliqState).optional().catch(undefined) })
)
export type ConnectorBotCliqStateResponse = z.infer<typeof ConnectorBotCliqStateResponse>

export const ConnectorBotCliqMembersResponse = z.object({
  members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().optional() })),
  complete: z.boolean()
})
export type ConnectorBotCliqMembersResponse = z.infer<typeof ConnectorBotCliqMembersResponse>
