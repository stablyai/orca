import { z } from 'zod'

const properties = {
  system_language: z.string().max(128).nullable(),
  system_language_supported: z.boolean(),
  detection_source: z.enum(['native', 'browser', 'browser-fallback']),
  effective_language: z.string().max(256)
}

export const onboardingLanguagePickerOpenedSchema = z.object(properties).strict()
export const onboardingLanguageChangedSchema = z
  .object({
    ...properties,
    selected_language: z.string().max(256)
  })
  .strict()
export const onboardingLanguageRequestedSchema = z.object(properties).strict()
