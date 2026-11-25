import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

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

/** A structured chat tab: an agent-session tab whose agent marks it as a native chat. */
export function makeStructuredChatTab(
  overrides: Partial<Tab> & { id: string; worktreeId: string; entityId: string }
): Tab {
  return makeUnifiedTab({
    groupId: 'g',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat',
    ...overrides
  })
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
