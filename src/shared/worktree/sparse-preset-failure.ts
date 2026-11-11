export const SPARSE_PRESET_FAILURE_COPY = {
  name_required: 'Preset name is required.',
  name_too_long: 'Preset name is too long.',
  directories_required: 'Preset must have at least one directory.',
  directories_invalid: 'Preset directories must be repo-relative paths.'
} as const

export type SparsePresetFailureCode = keyof typeof SPARSE_PRESET_FAILURE_COPY

export type SparsePresetFailure = {
  errorCode: string
  error: string
}

export class SparsePresetValidationError extends Error {
  readonly data: SparsePresetFailure

  constructor(code: SparsePresetFailureCode) {
    super(SPARSE_PRESET_FAILURE_COPY[code])
    this.data = { errorCode: code, error: this.message }
  }
}
