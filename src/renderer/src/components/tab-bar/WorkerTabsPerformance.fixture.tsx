import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { linkRecordWrite } from '@/store/record-transitions/keyed-record-transitions'
import { getSharedWorktreeAgentRowsSelector } from '../sidebar/workspace-card/activity/worktree-agent-rows-projection'
import { workerTabExecutionHost } from './worker-tab-execution-host'
import * as fold from './worker-tab-folding'
import * as presentation from './worker-tab-presentation'
import { indexedWorkerTab } from './worker-tab-index'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'

export const benchmark = defineFixture({
  setup: () => {
    Object.assign(window, {
      __workerTabsBenchmark: {
        store: useAppStore,
        getSharedWorktreeAgentRowsSelector,
        workerTabExecutionHost,
        linkRecordWrite,
        fold,
        presentation,
        indexedWorkerTab,
        acceptedAgentStatuses
      }
    })
  },
  render: () => <div />
})
