import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const properties = {
  system_language: z.string().max(128).nullable(),
  system_language_supported: z.boolean(),
  detection_source: z.enum(['native', 'browser', 'browser-fallback']),
  effective_language: z.string().max(256)
}

export const onboardingLanguagePickerOpenedSchema = lazyZodSchema(() =>
  z.object(properties).strict()
)
export const onboardingLanguageChangedSchema = lazyZodSchema(() =>
  z
    .object({
      ...properties,
      selected_language: z.string().max(256)
    })
    .strict()
)
export const onboardingLanguageRequestedSchema = lazyZodSchema(() => z.object(properties).strict())
