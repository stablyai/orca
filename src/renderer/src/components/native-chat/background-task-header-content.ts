// Desktop words for the background-tasks strip header (`shared/background-task-header-content.ts`).

import {
  backgroundTasksHeaderContent as headerContent,
  type BackgroundTasksHeaderContent
} from '../../../../shared/background-task-header-content'
import type { BackgroundTaskGroup } from '../../../../shared/background-task-roster'
import { sayBackgroundTaskTranslated } from './background-task-words-text'

export function backgroundTasksHeaderContent(
  groups: readonly BackgroundTaskGroup[],
  options: { narrow: boolean; now: number }
): BackgroundTasksHeaderContent {
  return headerContent(groups, options, sayBackgroundTaskTranslated)
}
