import { useAppStore } from '@/store/index'
import type { WorkspaceSeedNameOptions } from '../../../../../shared/workspace-name'

export function getJiraIssueKeyCasingSeedOptions(): WorkspaceSeedNameOptions {
  return { jiraIssueKeyCasing: useAppStore.getState().settings?.jiraIssueKeyCasing }
}
