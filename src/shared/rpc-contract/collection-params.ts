import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const CollectionCreate = z.object({
  name: requiredString('Missing collection name'),
  color: z.string().nullable().optional()
})

export const CollectionUpdate = z.object({
  collectionId: requiredString('Missing collection id'),
  updates: z.object({
    name: OptionalString,
    color: z.string().nullable().optional(),
    isCollapsed: z.boolean().optional(),
    order: OptionalFiniteNumber
  })
})

export const CollectionSelector = z.object({
  collectionId: requiredString('Missing collection id')
})
