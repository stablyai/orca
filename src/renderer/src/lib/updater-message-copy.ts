import { translate } from '@/i18n/i18n'
import type { LinuxPackageCommandUnavailableReason } from '../../../shared/update-status-types'
import {
  UPDATER_FAILURE_COPY as EN,
  type UpdaterFailureCode
} from '../../../shared/updater-failure-copy'

type Param = (name: string) => string | null
type CountParam = (name: string) => number | null

// null = required params missing; caller shows the host's English message.
const COPY: Record<UpdaterFailureCode, (param: Param, count: CountParam) => string | null> = {
  releaseNotReady: () => translate('updates.failure.releaseNotReady', EN.releaseNotReady),
  updateServerUnreachable: () =>
    translate('updates.failure.updateServerUnreachable', EN.updateServerUnreachable),
  channelUnsupportedPlatform: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate('updates.failure.channelUnsupportedPlatform', EN.channelUnsupportedPlatform, {
          channel
        })
  },
  unsignedDevChannel: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate('updates.failure.unsignedDevChannel', EN.unsignedDevChannel, { channel })
  },
  linuxPackageMissing: () =>
    translate('updates.failure.linuxPackageMissing', EN.linuxPackageMissing),
  linuxPackageNotRegular: () =>
    translate('updates.failure.linuxPackageNotRegular', EN.linuxPackageNotRegular),
  linuxPackageHashMismatch: () =>
    translate('updates.failure.linuxPackageHashMismatch', EN.linuxPackageHashMismatch),
  linuxPackageReadFailed: () =>
    translate('updates.failure.linuxPackageReadFailed', EN.linuxPackageReadFailed),
  linuxPackageNoSudo: () => translate('updates.failure.linuxPackageNoSudo', EN.linuxPackageNoSudo),
  linuxPackageNoPackageManager: () =>
    translate('updates.failure.linuxPackageNoPackageManager', EN.linuxPackageNoPackageManager),
  linuxPackageInvalidPath: () =>
    translate('updates.failure.linuxPackageInvalidPath', EN.linuxPackageInvalidPath),
  linuxPackageMarkerUnusable: () =>
    translate('updates.failure.linuxPackageMarkerUnusable', EN.linuxPackageMarkerUnusable),
  linuxPackageExternallyManaged: () =>
    translate('updates.failure.linuxPackageExternallyManaged', EN.linuxPackageExternallyManaged),
  linuxPackageManualInstall: () =>
    translate('updates.failure.linuxPackageManualInstall', EN.linuxPackageManualInstall),
  linuxPackageMetadataUnusable: () =>
    translate('updates.failure.linuxPackageMetadataUnusable', EN.linuxPackageMetadataUnusable),
  unknownReleaseChannel: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate('updates.failure.unknownReleaseChannel', EN.unknownReleaseChannel, { channel })
  },
  invalidReleaseTag: (param) => {
    const tag = param('tag')
    return tag === null
      ? null
      : translate('updates.failure.invalidReleaseTag', EN.invalidReleaseTag, { tag })
  },
  releaseRepoNotFound: (param) => {
    const repo = param('repo')
    return repo === null
      ? null
      : translate('updates.failure.releaseRepoNotFound', EN.releaseRepoNotFound, { repo })
  },
  releaseListFailed: (param, count) => {
    const channel = param('channel')
    const status = count('status')
    return channel === null || status === null
      ? null
      : translate('updates.failure.releaseListFailed', EN.releaseListFailed, { channel, status })
  },
  releaseListUnreadable: (param) => {
    const channel = param('channel')
    return channel === null
      ? null
      : translate('updates.failure.releaseListUnreadable', EN.releaseListUnreadable, { channel })
  },
  rateLimitedSoon: () => translate('updates.failure.rateLimitedSoon', EN.rateLimitedSoon),
  rateLimitedSoonSignedOut: () =>
    translate('updates.failure.rateLimitedSoonSignedOut', EN.rateLimitedSoonSignedOut),
  rateLimitedInMinute: () =>
    translate('updates.failure.rateLimitedInMinute', EN.rateLimitedInMinute),
  rateLimitedInMinuteSignedOut: () =>
    translate('updates.failure.rateLimitedInMinuteSignedOut', EN.rateLimitedInMinuteSignedOut),
  rateLimitedInMinutes: (_param, count) => {
    const minutes = count('count')
    return minutes === null
      ? null
      : translate('updates.failure.rateLimitedInMinutes', EN.rateLimitedInMinutes, {
          count: minutes,
          defaultValue_one: 'GitHub rate limit reached. Try again in about {{count}} minute.'
        })
  },
  rateLimitedInMinutesSignedOut: (_param, count) => {
    const minutes = count('count')
    return minutes === null
      ? null
      : translate(
          'updates.failure.rateLimitedInMinutesSignedOut',
          EN.rateLimitedInMinutesSignedOut,
          {
            count: minutes,
            defaultValue_one:
              "GitHub rate limit reached. Try again in about {{count}} minute, or run `gh auth login` so Orca can use your account's higher limit."
          }
        )
  }
}

const COMMAND_UNAVAILABLE_CODES: Record<LinuxPackageCommandUnavailableReason, UpdaterFailureCode> =
  {
    'no-sudo': 'linuxPackageNoSudo',
    'no-package-manager': 'linuxPackageNoPackageManager'
  }

function isUpdaterFailureCode(code: unknown): code is UpdaterFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

function codedText(code: unknown, params: unknown): string | null {
  if (!isUpdaterFailureCode(code)) {
    return null
  }
  const values: Record<string, unknown> =
    typeof params === 'object' && params !== null ? Object.fromEntries(Object.entries(params)) : {}
  return COPY[code](
    (name) => (typeof values[name] === 'string' ? values[name] : null),
    (name) => (typeof values[name] === 'number' ? values[name] : null)
  )
}

/** Updater message text: known codes translate; unknown codes and older hosts keep the English message. */
export function updaterMessageText(source: {
  message: string
  messageCode?: unknown
  messageParams?: unknown
}): string {
  return codedText(source.messageCode, source.messageParams) ?? source.message
}

/** The install-instructions result already names its reason; unknown reasons keep main's English. */
export function linuxPackageCommandUnavailableText(instructions: {
  reason: LinuxPackageCommandUnavailableReason
  message: string
}): string {
  return (
    codedText(
      Object.hasOwn(COMMAND_UNAVAILABLE_CODES, instructions.reason)
        ? COMMAND_UNAVAILABLE_CODES[instructions.reason]
        : undefined,
      undefined
    ) ?? instructions.message
  )
}
