// One English table for pet import refusals: main builds the wire `error`, the renderer translates by code.
export const PET_IMPORT_FAILURE_COPY = {
  unsupportedFile: 'Unsupported file. Pick a PNG, APNG, JPG, GIF, WebP, or SVG.',
  fileUnreadable: 'Could not read the selected file.',
  notAFile: 'Selected path is not a file',
  fileTooLarge: 'File is too large ({{size}} MB). Max is {{max}} MB.',
  saveFailed: 'Could not save the pet.',
  pathUnreadable: 'Could not read the selected path.',
  manifestMissing: 'Bundle is missing pet.json.',
  manifestInvalid: 'pet.json is invalid.',
  manifestSymlink: 'pet.json must not be a symlink.',
  manifestParseFailed: 'Invalid pet.json: {{detail}}',
  bundleSaveFailed: 'Could not save the pet bundle.',
  sheetPathNotRelative: 'spritesheetPath must be relative to the bundle.',
  sheetPathIsRoot: 'spritesheetPath must point to a file, not the bundle root.',
  sheetPathEscapes: 'spritesheetPath escapes the bundle.',
  sheetSymlink: 'spritesheet must not be a symlink.',
  sheetUnsupportedType: 'Spritesheet must be a PNG, APNG, JPG, GIF, or WebP.',
  sheetNotFound: 'Spritesheet file not found.',
  sheetNotAFile: 'Spritesheet path is not a file.',
  sheetTooLarge: 'Spritesheet is too large ({{size}} MB).',
  sheetSizeLimitExceeded: 'Spritesheet exceeded the size limit.',
  sheetUndecodable: 'Could not decode the spritesheet image.',
  sheetFrameMismatch:
    'Spritesheet {{sheetWidth}}×{{sheetHeight}} is not a clean multiple of frame {{frameWidth}}×{{frameHeight}}.',
  animationRowOutOfRange: 'Animation "{{name}}" references row {{row}} but sheet has {{rows}}.',
  animationTooManyFrames:
    'Animation "{{name}}" has {{frames}} frames but sheet only has {{columns}} columns.',
  animationDurationMismatch:
    'Animation "{{name}}" declares {{durations}} frame durations but {{frames}} frames.',
  defaultAnimationMissing: 'defaultAnimation "{{name}}" not in animations.'
} as const

export type PetImportFailureCode = keyof typeof PET_IMPORT_FAILURE_COPY

export type PetImportFailureParams = Record<string, string | number>

/** Wire shape: `error` stays English; `errorDetail` is verbatim diagnostic text. */
export type PetImportFailure = {
  ok: false
  error: string
  errorCode?: string
  errorParams?: PetImportFailureParams
  errorDetail?: string
}

/** Stored as the label when a pet has no usable name; the renderer shows it translated. */
export const CUSTOM_PET_DEFAULT_LABEL = 'Custom pet'
export const PET_BUNDLE_DEFAULT_LABEL = 'Pet bundle'

/** Thrown inside main's import steps; the IPC handler returns it as a PetImportFailure. */
export class PetImportError extends Error {
  readonly failure: PetImportFailure

  constructor(code: PetImportFailureCode, params: PetImportFailureParams = {}, detail?: string) {
    const values = detail === undefined ? params : { ...params, detail }
    // One pass, so a value containing "{{detail}}" stays verbatim.
    const error = PET_IMPORT_FAILURE_COPY[code].replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : slot
    )
    super(error)
    this.failure = {
      ok: false,
      error,
      errorCode: code,
      ...(Object.keys(params).length > 0 ? { errorParams: params } : {}),
      ...(detail !== undefined ? { errorDetail: detail } : {})
    }
  }
}

export function isPetImportFailure(value: unknown): value is PetImportFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === false &&
    'error' in value &&
    typeof value.error === 'string'
  )
}
