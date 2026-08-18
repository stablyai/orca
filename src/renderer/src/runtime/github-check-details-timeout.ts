import { translate } from '@/i18n/i18n'
import {
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE,
  isGitHubCheckDetailsTimeout
} from '../../../shared/github/check-details-deadline'

export const GITHUB_CHECK_DETAILS_TIMEOUT_MS = 30_000

function translatedTimeoutError(): Error {
  return new Error(
    translate(
      'auto.runtime.githubCheckDetailsTimeout.timedOut',
      GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
    )
  )
}

/** Bound the renderer operation and cancel transports that support AbortSignal. */
export async function withGitHubCheckDetailsTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(translatedTimeoutError())
      controller.abort()
    }, GITHUB_CHECK_DETAILS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } catch (error) {
    if (isGitHubCheckDetailsTimeout(error)) {
      throw translatedTimeoutError()
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
