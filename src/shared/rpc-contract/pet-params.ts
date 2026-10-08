import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

// Why 40: the pet menu truncates imported labels to 40 chars, so a longer CLI name would be cut silently.
export const PET_NAME_MAX_LENGTH = 40

function petName(message: string) {
  return requiredString(message).pipe(
    z
      .string()
      .trim()
      .min(1, message)
      .max(PET_NAME_MAX_LENGTH, `Pet name must be ${PET_NAME_MAX_LENGTH} characters or fewer`)
  )
}

export const PetImportBundle = z.object({
  path: requiredString('Missing pet bundle path'),
  name: petName('Missing pet name').optional()
})

export const PetSelector = z.object({
  pet: requiredString('Missing pet selector')
})

export const PetRename = z.object({
  pet: requiredString('Missing pet selector'),
  name: petName('Missing pet name')
})
