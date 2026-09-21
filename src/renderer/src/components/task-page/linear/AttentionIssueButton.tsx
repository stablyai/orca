import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import { parseLinearIssueUrlIntent } from '../../../../../shared/linear/links'
import { linearWorkspaceScopeSignature } from '../../../../../shared/linear/workspace-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'

export function AttentionIssueButton({
  issue,
  workspaceId,
  onOpenIssue
}: {
  issue: { id: string; url: string }
  workspaceId: string
  onOpenIssue: (issue: LinearIssue) => void
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const busy = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function open(): Promise<void> {
    if (busy.current) {
      return
    }
    busy.current = true
    setLoading(true)
    setError(null)
    const before = useAppStore.getState()
    const signature = linearWorkspaceScopeSignature(before.linearStatus)
    try {
      const intent = parseLinearIssueUrlIntent(issue.url)
      const status = await window.api.linear.status()
      if (linearWorkspaceScopeSignature(status) !== signature) {
        throw new Error('Linear connection changed. Refresh before opening this issue.')
      }
      const matches =
        status.workspaces?.filter(
          (workspace) =>
            workspace.organizationUrlKey?.toLowerCase() === intent?.organizationUrlKey.toLowerCase()
        ) ?? []
      if (!intent || matches.length !== 1 || matches[0].id !== workspaceId) {
        throw new Error('Select the matching Linear workspace before opening this issue.')
      }
      const resolved = await lookupLinearIssueUrl({
        intent,
        knownStatus: status,
        sourceContext: null,
        readLinearStatus: () => window.api.linear.status(),
        fetchLinearIssue: (identifier, selectedWorkspaceId) =>
          selectedWorkspaceId === workspaceId
            ? window.api.linear.getIssue({ id: identifier, workspaceId })
            : Promise.resolve(null)
      })
      if (!resolved || resolved.id !== issue.id || resolved.workspaceId !== workspaceId) {
        throw new Error(
          'This issue moved or is unavailable. Refresh the list or open it in Linear.'
        )
      }
      const current = useAppStore.getState()
      if (
        !mounted.current ||
        current.activeOrcaProfileId !== before.activeOrcaProfileId ||
        linearWorkspaceScopeSignature(current.linearStatus) !== signature
      ) {
        return
      }
      onOpenIssue(resolved)
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : 'Could not open issue.')
      }
    } finally {
      busy.current = false
      if (mounted.current) {
        setLoading(false)
      }
    }
  }
  return (
    <div className="space-y-1">
      <Button variant="outline" size="sm" disabled={loading} onClick={() => void open()}>
        {translate('linear.attention.openIssue', 'Open issue')}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
