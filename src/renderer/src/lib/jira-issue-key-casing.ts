import { useAppStore } from '@/store'
import type { WorkspaceSeedNameOptions } from '../../../shared/workspace-name'

/** Seed-name options carrying the user's Jira key casing setting. */
export function getJiraIssueKeyCasingSeedOptions(): WorkspaceSeedNameOptions {
  return { jiraIssueKeyCasing: useAppStore.getState().settings?.jiraIssueKeyCasing }
}
