import type {
  CloudApiErrorCode,
  CloudApiResult
} from '../../../../../shared/cloud-api/cloud-api-types'

export type CloudLoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: CloudApiErrorCode }
  | { status: 'ok'; data: T }

export type CloudApiFailure = Extract<CloudApiResult<unknown>, { ok: false }>

export function toCloudLoadState<T>(
  result: CloudApiResult<T>,
  word: (failure: CloudApiFailure) => string
): CloudLoadState<T> {
  return result.ok
    ? { status: 'ok', data: result.data }
    : { status: 'error', message: word(result), code: result.error }
}
