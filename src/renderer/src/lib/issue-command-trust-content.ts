import type { IssueCommandReadResult } from '@/runtime/runtime-hooks-client'

export function getIssueCommandTrustContent(result: IssueCommandReadResult): string {
  if (result.source === 'local') {
    return (result.localContent ?? '').trim()
  }
  if (result.source === 'shared') {
    return (result.sharedContent ?? '').trim()
  }
  return ''
}

// A committed .orca/issue-command came from the repo, so it needs the same trust as orca.yaml.
export function isUserOwnedIssueCommand(result: IssueCommandReadResult): boolean {
  return result.source === 'local' && result.localUntracked === true
}
