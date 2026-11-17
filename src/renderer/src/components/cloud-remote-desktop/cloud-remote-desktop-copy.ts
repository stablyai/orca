// What a remote desktop tab says when its desktop can't open, and the one next step it offers.
import type { Translate } from '@/i18n/use-translate'
import type { CloudRemoteDesktopFailureCode } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

export type CloudRemoteDesktopNextAction =
  | 'wake'
  | 'unarchive'
  | 'sign_in'
  | 'create_workspace'
  | 'retry'

export type FailureCopy = {
  title: string
  detail: string
  action: CloudRemoteDesktopNextAction | null
  /** Asleep, starting, signed out and not-available-here are states, not errors. */
  tone?: 'neutral'
}

export function failureCopy(t: Translate, code: CloudRemoteDesktopFailureCode): FailureCopy {
  switch (code) {
    case 'not_cloud':
      return {
        title: t(
          'components.cloudRemoteDesktop.notCloudTitle',
          'Remote desktop is only available in cloud workspaces.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.notCloudDetail',
          'Create a cloud workspace to run apps with a screen.'
        ),
        action: 'create_workspace',
        tone: 'neutral'
      }
    case 'not_running':
      return {
        title: t('components.cloudRemoteDesktop.asleepTitle', 'This workspace is asleep.'),
        detail: t(
          'components.cloudRemoteDesktop.asleepDetail',
          'Wake it to open the remote desktop. Your files are safe.'
        ),
        action: 'wake',
        tone: 'neutral'
      }
    case 'archived':
      return {
        title: t('components.cloudRemoteDesktop.archivedTitle', 'This workspace is archived.'),
        detail: t(
          'components.cloudRemoteDesktop.archivedDetail',
          'Unarchive it to open the remote desktop. Your files are safe.'
        ),
        action: 'unarchive',
        tone: 'neutral'
      }
    case 'starting':
      return {
        title: t(
          'components.cloudRemoteDesktop.startingTitle',
          'The workspace is still starting or waking.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.startingDetail',
          'Try again in a moment. Your files are safe.'
        ),
        action: 'retry',
        tone: 'neutral'
      }
    case 'not_installed':
      return {
        title: t(
          'components.cloudRemoteDesktop.notInstalledTitle',
          'This sandbox doesn’t have a remote desktop yet.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.notInstalledDetail',
          'It was created before remote desktop was available. New cloud workspaces include it. Your files are safe.'
        ),
        action: 'create_workspace',
        tone: 'neutral'
      }
    case 'signed_out':
      return {
        title: t(
          'components.cloudRemoteDesktop.signedOutTitle',
          'You’re signed out of Orca Cloud.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.signedOutDetail',
          'Sign in, then open the remote desktop again.'
        ),
        action: 'sign_in',
        tone: 'neutral'
      }
    case 'forward_failed':
      return {
        title: t(
          'components.cloudRemoteDesktop.forwardFailedTitle',
          'Couldn’t connect this computer to the remote desktop.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.forwardFailedDetail',
          'The desktop is running in the sandbox. Your files are safe.'
        ),
        action: 'retry'
      }
    case 'unavailable':
      return {
        title: t(
          'components.cloudRemoteDesktop.unavailableTitle',
          'Couldn’t start the remote desktop.'
        ),
        detail: t(
          'components.cloudRemoteDesktop.unavailableDetail',
          'Orca Cloud didn’t respond in time. Your files are safe.'
        ),
        action: 'retry'
      }
  }
}

export function actionLabel(t: Translate, action: CloudRemoteDesktopNextAction): string {
  switch (action) {
    case 'wake':
      return t('components.cloudRemoteDesktop.wake', 'Wake workspace')
    case 'unarchive':
      return t('components.cloudRemoteDesktop.unarchive', 'Unarchive')
    case 'sign_in':
      return t('components.cloudRemoteDesktop.signIn', 'Sign in')
    case 'create_workspace':
      return t('components.cloudRemoteDesktop.createWorkspace', 'Create workspace')
    case 'retry':
      return t('components.cloudRemoteDesktop.retry', 'Try again')
  }
}
