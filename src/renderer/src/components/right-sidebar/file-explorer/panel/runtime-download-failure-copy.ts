import type { Translate } from '@/i18n/use-translate'
import type { RuntimeDownloadErrorCode } from '../../../../../../shared/runtime-downloads/runtime-download-contract'

export type RuntimeDownloadFailureAction = 'retry' | 'download_instead' | 'refresh' | 'reveal'

export type RuntimeDownloadFailureCopy = {
  title: string
  detail: string
  /** 'neutral' for limits and deliberate refusals; 'error' when something actually broke. */
  tone: 'error' | 'neutral'
  action: RuntimeDownloadFailureAction | null
}

/** Cloud workspaces live in a sandbox; other runtime hosts are named generically. */
export type RuntimeDownloadPlace = 'sandbox' | 'host'

/** Glossary error tone: what happened, whether anything was lost, at most one next action. */
export function runtimeDownloadFailureCopy(
  t: Translate,
  state: {
    intent: 'save' | 'open'
    itemKind: 'file' | 'folder'
    name: string
    code: RuntimeDownloadErrorCode
    place: RuntimeDownloadPlace
  }
): RuntimeDownloadFailureCopy {
  const { name, place } = state
  const title =
    state.intent === 'open'
      ? t('components.runtimeDownload.openFailedTitle', 'Couldn’t open {{name}}', { name })
      : t('components.runtimeDownload.failedTitle', 'Couldn’t download {{name}}', { name })
  const transferFailed: RuntimeDownloadFailureCopy = {
    title,
    detail: t(
      'components.runtimeDownload.transferFailed',
      'Something went wrong while copying it. Nothing was saved on this computer.'
    ),
    tone: 'error',
    action: 'retry'
  }
  switch (state.code) {
    case 'too_large':
      if (state.itemKind === 'folder') {
        return {
          title,
          detail: t(
            'components.runtimeDownload.folderTooLarge',
            'This folder is over 2 GB, the most Orca can download at once. Download the folders inside it one at a time. Nothing was saved on this computer.'
          ),
          tone: 'neutral',
          action: null
        }
      }
      return state.intent === 'open'
        ? {
            title,
            detail: t(
              'components.runtimeDownload.tooLargeToOpen',
              'Files over 1 GB can’t be opened directly. Download it instead.'
            ),
            tone: 'neutral',
            action: 'download_instead'
          }
        : {
            title,
            detail: t(
              'components.runtimeDownload.fileGrew',
              'The file grew while Orca was copying it. Nothing was saved on this computer.'
            ),
            tone: 'error',
            action: 'retry'
          }
    case 'too_many_entries':
      return {
        title,
        detail: t(
          'components.runtimeDownload.folderTooManyItems',
          'This folder has more than 65,000 items, the most Orca can download at once. Download the folders inside it one at a time. Nothing was saved on this computer.'
        ),
        tone: 'neutral',
        action: null
      }
    case 'open_refused':
      return {
        title,
        detail: t(
          'components.runtimeDownload.openRefused',
          'Orca doesn’t open files that can run programs, like scripts, installers and apps. Download it to check it first. Nothing was saved on this computer.'
        ),
        tone: 'neutral',
        action: 'download_instead'
      }
    case 'host_update_required':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.sandboxUpdateRequired',
                'This sandbox runs an older version of Orca. New cloud workspaces include downloads. Your files are safe.'
              )
            : t(
                'components.runtimeDownload.hostUpdateRequired',
                'The remote host runs an older version of Orca. Update Orca there, then try again.'
              ),
        tone: 'error',
        action: null
      }
    case 'host_busy':
      return {
        title,
        detail: t(
          'components.runtimeDownload.busy',
          'Too many downloads are running. Wait for one to finish, then try again.'
        ),
        tone: 'error',
        action: 'retry'
      }
    case 'not_found':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.notFoundInSandboxNothingSaved',
                'It was moved or deleted in the sandbox. Nothing was saved on this computer.'
              )
            : t(
                'components.runtimeDownload.notFoundOnHostNothingSaved',
                'It was moved or deleted on the remote host. Nothing was saved on this computer.'
              ),
        tone: 'error',
        action: 'refresh'
      }
    case 'not_a_file':
    case 'not_a_directory':
      return {
        title,
        detail: t(
          'components.runtimeDownload.changed',
          'It changed while Orca was reading it. Try again.'
        ),
        tone: 'error',
        action: 'retry'
      }
    case 'disconnected':
      return {
        title,
        detail:
          place === 'sandbox'
            ? t(
                'components.runtimeDownload.sandboxDisconnected',
                'The connection to the sandbox dropped. Nothing was saved on this computer.'
              )
            : t(
                'components.runtimeDownload.hostDisconnected',
                'The connection to the remote host dropped. Nothing was saved on this computer.'
              ),
        tone: 'error',
        action: 'retry'
      }
    case 'canceled':
      // Unreachable: outcomeState drops canceled results. Never offer "Try again" for a cancel.
      return { ...transferFailed, action: null }
    case 'open_failed':
    case 'transfer_failed':
      return transferFailed
  }
}

/** The file was saved, but nothing on this computer opens its type: a soft state, not a failure. */
export function runtimeDownloadNoAppCopy(t: Translate, name: string): RuntimeDownloadFailureCopy {
  return {
    title: t('components.runtimeDownload.savedName', 'Saved {{name}}', { name }),
    detail: t(
      'components.runtimeDownload.noAppForType',
      'No app on this computer opens this file type. Reveal it to choose one.'
    ),
    tone: 'neutral',
    action: 'reveal'
  }
}
