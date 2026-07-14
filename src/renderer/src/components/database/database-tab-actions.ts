import { DEFAULT_DATABASE_TAB_STATE } from '../../../../shared/database-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function openDatabaseTab(worktreeId: string, targetGroupId?: string): string {
  const state = useAppStore.getState()
  const tab = state.createUnifiedTab(worktreeId, 'database', {
    label: translate('auto.components.database.tab.title', 'Database Query'),
    database: {
      connection: { ...DEFAULT_DATABASE_TAB_STATE.connection },
      queryDraft: DEFAULT_DATABASE_TAB_STATE.queryDraft,
      readOnly: DEFAULT_DATABASE_TAB_STATE.readOnly
    },
    targetGroupId,
    activate: true
  })
  state.activateTab(tab.id)
  state.setActiveTabType('database')
  return tab.id
}
