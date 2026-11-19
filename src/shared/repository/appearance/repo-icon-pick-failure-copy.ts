// One English table for repo icon upload refusals: main builds the wire `error`, the renderer translates by code.
export const REPO_ICON_PICK_FAILURE_COPY = {
  notPng: 'Choose a PNG or JPEG image.',
  tooLarge: 'Image must be {{limit}} or smaller.',
  dimensionsTooLarge: 'Image dimensions are too large.',
  invalidImage: 'This image could not be read.',
  cannotCompress: 'This image could not be compressed to {{limit}}.'
} as const

export type RepoIconPickFailureCode = keyof typeof REPO_ICON_PICK_FAILURE_COPY

/** Wire shape: `error` stays English; the renderer translates known codes. */
export type RepoIconPickFailure = { ok: false; error: string; errorCode?: string }

export function repoIconPickFailure(
  errorCode: RepoIconPickFailureCode,
  values?: Readonly<Record<string, string>>
): RepoIconPickFailure {
  const template = REPO_ICON_PICK_FAILURE_COPY[errorCode]
  return {
    ok: false,
    error: values
      ? template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
      : template,
    errorCode
  }
}
