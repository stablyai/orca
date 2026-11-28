import { fileTypeOfPath, pluginFileTypeSchema } from '../plugins/contributions/plugin-file-type'

const MAX_EXTERNAL_FILE_TYPES = 256

export type ExternalAppFileSettings = {
  /** File types the user chose, from the binary tab, to hand straight to this computer's default
   *  app on a plain link click. Absent means every untrusted link stays in Orca. */
  externalAppFileTypes?: string[]
}

/** Unvalidated opt-ins as a settings write or load carries them. */
export type ExternalAppFileSettingsInput = {
  [Key in keyof ExternalAppFileSettings]?: unknown
}

/** Bounds the opt-in list on every write and load; only keys present in `input` return. */
export function normalizeExternalAppFileSettings(
  input: ExternalAppFileSettingsInput
): Partial<ExternalAppFileSettings> {
  if (!('externalAppFileTypes' in input)) {
    return {}
  }
  const value = input.externalAppFileTypes
  const valid = Array.isArray(value)
    ? value.filter((entry): entry is string => pluginFileTypeSchema.safeParse(entry).success)
    : []
  const newest = new Set<string>()
  for (const fileType of valid) {
    // Why delete first: a repeat moves to the end, so the newest opt-ins survive the cap.
    newest.delete(fileType)
    newest.add(fileType)
  }
  return { externalAppFileTypes: [...newest].slice(-MAX_EXTERNAL_FILE_TYPES) }
}

/** True only for a type the user explicitly opted into external opens; untrusted text never opts in. */
export function prefersExternalAppForFile(
  filePath: string,
  externalAppFileTypes: readonly string[] | undefined
): boolean {
  const fileType = fileTypeOfPath(filePath)
  return fileType !== null && (externalAppFileTypes?.includes(fileType) ?? false)
}
