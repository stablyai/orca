import { getUpdateInstallBlockGuidance } from './update-install-block-guidance'
import type { UpdateStatus } from '../../../../../shared/update-status-types'
import type { UpdateErrorCardModel } from '../../UpdateErrorCardContent'
import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from '../../../../../shared/updater-windows-signature-check'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import { translate } from '@/i18n/i18n'
import { updaterMessageText } from '@/lib/updater-message-copy'
import { isHttp2ProtocolError } from './update-card-visibility'

export function buildUpdateCardErrorModel({
  status,
  isLocalBuild,
  cachedVersion,
  installError,
  compatibilityRelaunching,
  compatibilitySetupError,
  onChooseLocalBuild,
  onEnableHttp1Compatibility,
  onRetryDownload,
  onRecheck,
  onInstallRetry
}: {
  status: UpdateStatus
  isLocalBuild: boolean
  cachedVersion: string | null
  installError: string | null
  compatibilityRelaunching: boolean
  compatibilitySetupError: string | null
  onChooseLocalBuild: () => void
  onEnableHttp1Compatibility: () => void
  onRetryDownload: () => void
  onRecheck: () => void
  onInstallRetry: () => void
}): UpdateErrorCardModel | null {
  if (status.state !== 'error') {
    return installError
      ? {
          title: translate('auto.components.UpdateCard.4cf109845a', 'Update Error'),
          summary: translate(
            'auto.components.UpdateCard.restartToInstallFailed',
            'Could not restart to install the update.'
          ),
          detail: installError,
          releaseUrl: getReleaseNotesUrlForVersion(cachedVersion),
          primaryAction: {
            label: translate('auto.components.UpdateCard.2c2d3e03ca', 'Try Again'),
            onClick: onInstallRetry
          }
        }
      : null
  }
  // Raw checks below match the host's English; display text translates known codes.
  const message = updaterMessageText(status)
  if (status.installBlock && status.retryAction === 'install' && status.retryable !== false) {
    return {
      variant: 'waiting',
      ...getUpdateInstallBlockGuidance(status.installBlock),
      blockers: status.installBlock.instances,
      detail: message,
      deferLabel: translate('updates.installBlock.later', 'Later'),
      footnote: {
        text: translate(
          'updates.installBlock.retainedDownload',
          'Orca stays open. No need to download again.'
        )
      },
      primaryAction: {
        label: translate('updates.installBlock.retryInstallation', 'Retry installation'),
        onClick: onInstallRetry
      }
    }
  }
  if (status.retryAction === 'install' && status.retryable !== false) {
    return {
      title: translate('auto.components.UpdateCard.4cf109845a', 'Update Error'),
      summary: message,
      detail: message,
      releaseUrl: getReleaseNotesUrlForVersion(cachedVersion),
      primaryAction: {
        label: translate('auto.components.UpdateCard.2c2d3e03ca', 'Try Again'),
        onClick: onInstallRetry
      }
    }
  }
  if (isLocalBuild) {
    return {
      title: cachedVersion
        ? translate('auto.components.UpdateCard.8cf17b10af', 'Local Build Error')
        : translate('auto.components.UpdateCard.a4650b0dc4', 'Could Not Use Local Build'),
      summary: cachedVersion
        ? translate(
            'auto.components.UpdateCard.b1e390250d',
            'Could not complete the local build switch.'
          )
        : translate(
            'auto.components.UpdateCard.d29740d175',
            'The selected build could not be used.'
          ),
      detail: message,
      primaryAction: {
        label: translate('auto.components.UpdateCard.37d45c9ec1', 'Choose Another Build'),
        onClick: onChooseLocalBuild
      }
    }
  }
  if (isHttp2ProtocolError(status.message)) {
    return {
      variant: 'http1Compatibility',
      title: translate('auto.components.UpdateCard.1339b82cee', 'HTTP/2 Download Blocked'),
      summary: translate(
        'auto.components.UpdateCard.http1RetryAvailable',
        'Orca can retry through HTTP/1.1 compatibility mode.'
      ),
      explainer: translate(
        'auto.components.UpdateCard.90559b14e3',
        'This turns on a process-wide Electron networking switch after restart. Use it for corporate VPNs or proxies that reject HTTP/2 update downloads.'
      ),
      detail: compatibilitySetupError ?? message,
      releaseUrl: getReleaseNotesUrlForVersion(cachedVersion),
      primaryAction: {
        label: translate('auto.components.UpdateCard.933c6fdf5b', 'Enable & Restart'),
        pendingLabel: translate('auto.components.UpdateCard.restarting', 'Restarting...'),
        isPending: compatibilityRelaunching,
        onClick: onEnableHttp1Compatibility
      }
    }
  }
  if (isWindowsSignatureMismatchFailure(status.message)) {
    return {
      variant: 'security',
      title: translate('auto.components.UpdateCard.5b309b19f3', "Update Wasn't Installed"),
      summary: translate(
        'auto.components.UpdateCard.092f09fc14',
        "The installer's publisher doesn't match Orca, so we stopped the update. Don't install this download; check official releases for a corrected version."
      ),
      detail: message,
      releaseUrl: getReleaseNotesUrlForVersion(null),
      manualLabel: translate('auto.components.UpdateCard.c9ff9b9ec2', 'Check official releases')
    }
  }
  if (isWindowsSignatureCheckUnavailableFailure(status.message)) {
    return {
      title: translate('auto.components.UpdateCard.e944c2de43', 'Update Verification Blocked'),
      summary: translate(
        'auto.components.UpdateCard.a05992a26b',
        "The signature check couldn't run — usually because antivirus software blocked it. Retry the download, or get the installer from our official releases."
      ),
      detail: message,
      releaseUrl: getReleaseNotesUrlForVersion(cachedVersion),
      primaryAction: {
        label: translate('auto.components.UpdateCard.48565a32bc', 'Retry Download'),
        onClick: onRetryDownload
      }
    }
  }
  return {
    title: cachedVersion
      ? translate('auto.components.UpdateCard.4cf109845a', 'Update Error')
      : translate('auto.components.UpdateCard.updateCheckFailed', 'Update Check Failed'),
    summary:
      cachedVersion && status.retryable === false
        ? message
        : cachedVersion
          ? translate(
              'auto.components.UpdateCard.updateIncomplete',
              'Could not complete the update.'
            )
          : translate('auto.components.UpdateCard.checkFailed', 'Could not check for updates.'),
    detail: message,
    releaseUrl: getReleaseNotesUrlForVersion(cachedVersion),
    primaryAction:
      cachedVersion && status.retryable !== false
        ? {
            label: translate('auto.components.UpdateCard.48565a32bc', 'Retry Download'),
            onClick: onRetryDownload
          }
        : !cachedVersion
          ? {
              label: translate('auto.components.UpdateCard.6b0085010d', 'Re-check'),
              onClick: onRecheck
            }
          : undefined
  }
}
