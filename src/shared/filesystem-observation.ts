import { isDefinitiveAbsence } from './definitive-filesystem-absence'

/**
 * A filesystem read either answered, definitively answered "not there", or
 * failed to answer at all.
 *
 * `existsSync` collapses the last two into `false`, and a `catch` that returns a
 * default collapses them into the default. That is how a held lock comes to
 * authorise an overwrite or a delete: the caller reads "this file is not there"
 * from evidence that says only "I could not look".
 */
export type FilesystemObservation<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'indeterminate'; error: unknown }

/**
 * Classify any read. Only `ENOENT`/`ENOTDIR` are absence — every other errno,
 * including unrecognised ones, is indeterminate. Mapping an unknown errno to a
 * verdict is the category error this module exists to prevent.
 */
export function observe<T>(read: () => T): FilesystemObservation<T> {
  try {
    return { kind: 'present', value: read() }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'indeterminate', error }
  }
}
