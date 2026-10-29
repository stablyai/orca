import { translate } from '@/i18n/i18n'
import type { CustomPet } from '../../../../shared/pet-types'
import {
  CUSTOM_PET_DEFAULT_LABEL,
  PET_BUNDLE_DEFAULT_LABEL,
  PET_IMPORT_FAILURE_COPY as EN,
  type PetImportFailure,
  type PetImportFailureCode
} from '../../../../shared/pet-import-failure-copy'

type Values = {
  text: (name: string) => string | null
  count: (name: string) => number | null
}

// null = required values missing; caller shows main's English `error`.
const COPY: Record<PetImportFailureCode, (values: Values) => string | null> = {
  unsupportedFile: () => translate('pet.importErrors.unsupportedFile', EN.unsupportedFile),
  fileUnreadable: () => translate('pet.importErrors.fileUnreadable', EN.fileUnreadable),
  notAFile: () => translate('pet.importErrors.notAFile', EN.notAFile),
  fileTooLarge: ({ text, count }) => {
    const size = text('size')
    const max = count('max')
    return size === null || max === null
      ? null
      : translate('pet.importErrors.fileTooLarge', EN.fileTooLarge, { size, max })
  },
  saveFailed: () => translate('pet.importErrors.saveFailed', EN.saveFailed),
  pathUnreadable: () => translate('pet.importErrors.pathUnreadable', EN.pathUnreadable),
  manifestMissing: () => translate('pet.importErrors.manifestMissing', EN.manifestMissing),
  manifestInvalid: () => translate('pet.importErrors.manifestInvalid', EN.manifestInvalid),
  manifestSymlink: () => translate('pet.importErrors.manifestSymlink', EN.manifestSymlink),
  manifestParseFailed: ({ text }) => {
    const detail = text('detail')
    return detail === null
      ? null
      : translate('pet.importErrors.manifestParseFailed', EN.manifestParseFailed, { detail })
  },
  bundleSaveFailed: () => translate('pet.importErrors.bundleSaveFailed', EN.bundleSaveFailed),
  sheetPathNotRelative: () =>
    translate('pet.importErrors.sheetPathNotRelative', EN.sheetPathNotRelative),
  sheetPathIsRoot: () => translate('pet.importErrors.sheetPathIsRoot', EN.sheetPathIsRoot),
  sheetPathEscapes: () => translate('pet.importErrors.sheetPathEscapes', EN.sheetPathEscapes),
  sheetSymlink: () => translate('pet.importErrors.sheetSymlink', EN.sheetSymlink),
  sheetUnsupportedType: () =>
    translate('pet.importErrors.sheetUnsupportedType', EN.sheetUnsupportedType),
  sheetNotFound: () => translate('pet.importErrors.sheetNotFound', EN.sheetNotFound),
  sheetNotAFile: () => translate('pet.importErrors.sheetNotAFile', EN.sheetNotAFile),
  sheetTooLarge: ({ text }) => {
    const size = text('size')
    return size === null
      ? null
      : translate('pet.importErrors.sheetTooLarge', EN.sheetTooLarge, { size })
  },
  sheetSizeLimitExceeded: () =>
    translate('pet.importErrors.sheetSizeLimitExceeded', EN.sheetSizeLimitExceeded),
  sheetUndecodable: () => translate('pet.importErrors.sheetUndecodable', EN.sheetUndecodable),
  sheetFrameMismatch: ({ count }) => {
    const sheetWidth = count('sheetWidth')
    const sheetHeight = count('sheetHeight')
    const frameWidth = count('frameWidth')
    const frameHeight = count('frameHeight')
    return sheetWidth === null ||
      sheetHeight === null ||
      frameWidth === null ||
      frameHeight === null
      ? null
      : translate('pet.importErrors.sheetFrameMismatch', EN.sheetFrameMismatch, {
          sheetWidth,
          sheetHeight,
          frameWidth,
          frameHeight
        })
  },
  animationRowOutOfRange: ({ text, count }) => {
    const name = text('name')
    const row = count('row')
    const rows = count('rows')
    return name === null || row === null || rows === null
      ? null
      : translate('pet.importErrors.animationRowOutOfRange', EN.animationRowOutOfRange, {
          name,
          row,
          rows
        })
  },
  animationTooManyFrames: ({ text, count }) => {
    const name = text('name')
    const frames = count('frames')
    const columns = count('columns')
    return name === null || frames === null || columns === null
      ? null
      : translate('pet.importErrors.animationTooManyFrames', EN.animationTooManyFrames, {
          name,
          frames,
          columns
        })
  },
  animationDurationMismatch: ({ text, count }) => {
    const name = text('name')
    const durations = count('durations')
    const frames = count('frames')
    return name === null || durations === null || frames === null
      ? null
      : translate('pet.importErrors.animationDurationMismatch', EN.animationDurationMismatch, {
          name,
          durations,
          frames
        })
  },
  defaultAnimationMissing: ({ text }) => {
    const name = text('name')
    return name === null
      ? null
      : translate('pet.importErrors.defaultAnimationMissing', EN.defaultAnimationMissing, {
          name
        })
  }
}

function isPetImportFailureCode(code: unknown): code is PetImportFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Unknown or uncoded failures show main's English text. */
export function petImportFailureText(failure: PetImportFailure): string {
  if (!isPetImportFailureCode(failure.errorCode)) {
    return failure.error
  }
  const params = failure.errorParams ?? {}
  const read = (name: string): unknown => (Object.hasOwn(params, name) ? params[name] : undefined)
  return (
    COPY[failure.errorCode]({
      text: (name) => {
        const value = name === 'detail' ? failure.errorDetail : read(name)
        return typeof value === 'string' ? value : null
      },
      count: (name) => {
        const value = read(name)
        return typeof value === 'number' && Number.isFinite(value) ? value : null
      }
    }) ?? failure.error
  )
}

/** Default names are stored in English; show them in the UI language. */
export function customPetLabel(pet: Pick<CustomPet, 'label' | 'kind'>): string {
  if (pet.kind === 'bundle') {
    return pet.label === PET_BUNDLE_DEFAULT_LABEL
      ? translate('pet.defaultLabels.bundle', PET_BUNDLE_DEFAULT_LABEL)
      : pet.label
  }
  return pet.label === CUSTOM_PET_DEFAULT_LABEL
    ? translate('pet.defaultLabels.image', CUSTOM_PET_DEFAULT_LABEL)
    : pet.label
}
