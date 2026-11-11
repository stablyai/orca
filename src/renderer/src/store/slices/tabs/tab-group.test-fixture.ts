import type { Tab, TabGroup } from '../../../../../shared/tab-types'

import { translate } from '@/i18n/i18n'

export function makeUnifiedTab(
  overrides: Partial<Tab> & { id: string; worktreeId: string; groupId: string }
): Tab {
  return {
    entityId: overrides.id,
    contentType: 'terminal',
    label: translate('auto.store.slices.store.test.helpers.b9a8117c33', 'Terminal 1'),
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

export function makeTabGroup(
  overrides: Partial<TabGroup> & { id: string; worktreeId: string }
): TabGroup {
  return {
    activeTabId: null,
    tabOrder: [],
    ...overrides
  }
}
