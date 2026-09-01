import { translate } from '@/i18n/i18n'
import type {
  OdooBoardStatusSyncMessage,
  OdooBoardStatusSyncResult
} from './workspace-board-odoo-status-sync'

export function formatOdooBoardStatusSyncMessage(message: OdooBoardStatusSyncMessage): string {
  switch (message.kind) {
    case 'ticket-read-failed':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.4a5685040a',
        'Odoo ticket {{value0}} could not be read.',
        { value0: message.ticketRef }
      )
    case 'unmapped-status':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.9f53c5b352',
        'No Odoo stage is mapped to {{value0}}.',
        { value0: message.statusLabel }
      )
    case 'missing-stage':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.e309459198',
        'Odoo has no stage named "{{value0}}" for {{value1}}.',
        { value0: message.stageName, value1: message.statusLabel }
      )
    case 'ambiguous-stage':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.94098edcf0',
        'Several Odoo stages are named "{{value0}}", so {{value1}} is ambiguous.',
        { value0: message.stageName, value1: message.statusLabel }
      )
    case 'update-failed':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.69cefc6a59',
        'Could not move Odoo ticket {{value0}}.',
        { value0: message.ticketRef }
      )
    case 'provider-error':
      return translate(
        'auto.components.sidebar.odoo.board.status.sync.report.3d200a7d84',
        'Could not sync Odoo ticket {{value0}}.',
        { value0: message.ticketRef }
      )
  }
}

export function formatOdooBoardStatusSyncDescription(result: OdooBoardStatusSyncResult): string {
  const counts = [
    result.updated > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.c7d8e9f0a1',
          '{{value0}} updated',
          {
            value0: result.updated
          }
        )
      : null,
    result.skipped > 0
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.d8e9f0a1b2',
          '{{value0}} skipped',
          {
            value0: result.skipped
          }
        )
      : null,
    result.failed > 0
      ? translate('auto.components.sidebar.WorkspaceKanbanDrawer.e9f0a1b2c3', '{{value0}} failed', {
          value0: result.failed
        })
      : null
  ].filter((part): part is string => part !== null)
  return [
    counts.join(', '),
    result.messages[0] ? formatOdooBoardStatusSyncMessage(result.messages[0]) : null
  ]
    .filter(Boolean)
    .join('. ')
}
