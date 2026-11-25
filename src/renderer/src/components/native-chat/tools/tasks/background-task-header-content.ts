import {
  backgroundTasksHeaderContent as headerContent,
  type BackgroundTasksHeaderContent
} from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-header-content'
import type { BackgroundTaskGroup } from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-roster'
import { sayBackgroundTaskTranslated } from './background-task-words-text'

export function backgroundTasksHeaderContent(
  groups: readonly BackgroundTaskGroup[],
  options: { narrow: boolean; now: number }
): BackgroundTasksHeaderContent {
  return headerContent(groups, options, sayBackgroundTaskTranslated)
}
