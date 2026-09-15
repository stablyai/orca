import type { JiraAuthType } from './jira-types'

/** Narrows an untrusted auth type (IPC, RPC, disk) to a known value; unknown means Cloud. */
export function normalizeJiraAuthType(value: unknown): JiraAuthType {
  return value === 'server' || value === 'cloud-scoped' ? value : 'cloud'
}
