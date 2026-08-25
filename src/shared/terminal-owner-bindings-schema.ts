import { z } from 'zod'
import { terminalOwnerIdentitySchema } from './terminal-owner-identity-schema'
import { salvagedOptional, salvagingRecord } from './zod-salvage'

export const terminalPtyOwnersByPaneKeySchema = salvagedOptional(
  'terminalPtyOwnersByPaneKey',
  salvagingRecord(z.string(), terminalOwnerIdentitySchema)
)
