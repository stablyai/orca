import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { UpdateInstallBlock } from '../../../../../shared/update-status-types'

export function getUpdateInstallBlockGuidance(
  block: UpdateInstallBlock,
  t: Translate = translate
): {
  title: string
  summary: string
  explainer: string
} {
  if (block.reason === 'busy') {
    return {
      title: t('updates.installBlock.busyTitle', 'Another Orca is updating'),
      summary: t(
        'updates.installBlock.busySummary',
        'An update is already being installed by another Orca instance.'
      ),
      explainer: t(
        'updates.installBlock.busyGuidance',
        'Wait a moment, then retry. Your downloaded update is ready.'
      )
    }
  }
  if (block.reason === 'unresponsive') {
    return {
      title: t('updates.installBlock.unresponsiveTitle', 'Waiting for background servers'),
      summary: t(
        'updates.installBlock.unresponsiveSummary',
        'Orca could not finish pausing its background servers for the update.'
      ),
      explainer: t(
        'updates.installBlock.unresponsiveGuidance',
        'Stop it from the terminal or service that started it, then retry. Connected devices will disconnect.'
      )
    }
  }
  if (block.instances.length > 0 && block.instances.every(({ kind }) => kind === 'browser')) {
    // A helper an older orcad runs never pauses for installs; ending it leaves orcad and terminals up.
    return {
      title: t('updates.installBlock.readyTitle', 'Your update is ready'),
      summary: t(
        'updates.installBlock.browserSummary',
        "A background Orca server's browser is still using this app."
      ),
      explainer: t(
        'updates.installBlock.browserGuidance',
        'End the process below, then retry: its server keeps running without a browser. If another computer uses this Mac as an SSH host, updating Orca there lets the browser pause for updates on its own.'
      )
    }
  }
  const hasServers = block.instances.some(({ kind }) => kind === 'server' || kind === 'browser')
  const onlyServers =
    block.instances.length > 0 &&
    block.instances.every(({ kind }) => kind === 'server' || kind === 'browser')
  return {
    title: t('updates.installBlock.readyTitle', 'Your update is ready'),
    summary: onlyServers
      ? t('updates.installBlock.serverSummary', 'A background Orca server is still using this app.')
      : t('updates.installBlock.instanceSummary', 'Another Orca instance is still using this app.'),
    explainer: onlyServers
      ? t(
          'updates.installBlock.serverGuidance',
          'Stop the server from the terminal or service that started it, then retry. Connected devices will disconnect.'
        )
      : hasServers
        ? t(
            'updates.installBlock.mixedGuidance',
            'Close any other Orca windows and stop the server from the terminal or service that started it. Connected devices will disconnect. Then retry.'
          )
        : t(
            'updates.installBlock.instanceGuidance',
            'Quit other Orca instances, then retry. Your downloaded update will be kept ready.'
          )
  }
}
