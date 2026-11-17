// The setup panel's GitHub row from the repository-access check, in the panel's CloudSetupStep
// shape. Missing access is fixed by the primary button ("Give access and start"); an owner who
// must approve on GitHub, or no GitHub remote, blocks a start, so ⌘↵ runs on this computer.
import type { OrcaCloudGitHubSetupRow } from '@/lib/orca-cloud/orca-cloud-github-setup-row'
import type { CloudSetupStep } from './cloud-start-model'

export function toGitHubSetupStep(
  row: OrcaCloudGitHubSetupRow,
  {
    loading,
    openUrl
  }: {
    /** True until the first answer for this repository arrives. */
    loading: boolean
    openUrl: (url: string) => void
  }
): CloudSetupStep | null {
  const shared = {
    id: 'github' as const,
    label: row.label,
    ...(row.status ? { status: row.status } : {}),
    ...(row.step.detail ? { detail: row.step.detail } : {}),
    ...(row.note ? { note: row.note } : {})
  }
  const action = row.action
  switch (row.step.state) {
    case 'done':
      return { ...shared, state: 'done' }
    case 'needed':
      return { ...shared, state: 'needed', need: 'github', canFix: true }
    case 'pending':
      return { ...shared, state: 'pending', need: 'github', blocksStart: true }
    case 'failed':
      return {
        ...shared,
        // No GitHub remote isn't a step that failed; the row explains itself, with no status word.
        status: row.status ?? '',
        state: 'failed',
        need: 'github',
        blocksStart: true,
        ...(action ? { action: { label: action.label, onClick: () => openUrl(action.url) } } : {})
      }
    case 'active':
      // Checking shows a Skeleton; "couldn't tell" (signed out, offline) never blocks, so no row.
      return loading ? { id: 'github', label: row.label, state: 'loading' } : null
  }
}
