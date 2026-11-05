import { afterEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import {
  clearPaneUseForTests,
  paneUseRecordCountForTests,
  readPaneUse,
  recordPaneUse
} from './chat-pane-use'

afterEach(() => clearPaneUseForTests())

function liveTab(entityId: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId: 'g',
    worktreeId: 'wt',
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('chat pane use', () => {
  // Why: users who never add a selection still open and close tabs all day; their records must not pile up.
  it('drops records of closed tabs as tabs churn, keeping open ones', () => {
    const open = liveTab('kept')
    const tabs = () => ({ wt: [open] })
    recordPaneUse('wt', 'kept', tabs)
    for (let index = 0; index < 1000; index++) {
      recordPaneUse('wt', `closed-${index}`, tabs)
    }
    expect(paneUseRecordCountForTests()).toBeLessThanOrEqual(65)
    expect(readPaneUse(tabs())('wt', 'kept')).toBeTypeOf('number')
    expect(paneUseRecordCountForTests()).toBe(1)
  })
})
