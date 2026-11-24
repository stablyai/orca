import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  projectWindowFrameSelections,
  type FrameWorkerSlices
} from '@/store/workspace-layout/workspace-layout-cache'
import { selectFoldedWorkerTabIds } from './worker-tab-folding'

const hasWorkers = (tabs: readonly Tab[]): boolean => tabs.some((tab) => Boolean(tab.workerTab))

/** Main owns membership; worker folds are this window's selection policy. */
export function preserveWorkerTabFrameSelections<T extends FrameWorkerSlices>(
  state: AppState,
  built: T
): T {
  return projectWindowFrameSelections(state, built, hasWorkers, selectFoldedWorkerTabIds)
}
