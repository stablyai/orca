// Renders the sanitized plan body, fetched on demand.
//
// The body is NOT on the task projection — it is the largest and highest-risk
// field in the feature, so it crosses IPC only when a human opens it, and only
// for the task that owns it. Collapsed by default for the same reason.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type Props = {
  taskId: string
  artifactId: string
  truncated: boolean
  redactionCount: number
}

export function AuditedPlanArtifactView({
  taskId,
  artifactId,
  truncated,
  redactionCount
}: Props): React.JSX.Element {
  const loadArtifact = useAppStore((s) => s.loadAuditedPlanArtifact)
  // Keyed by artifactId, so a new round never shows the previous body.
  const body = useAppStore((s) => s.auditedPlanArtifactBodies[artifactId])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const handleToggle = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (body !== undefined) {
      return
    }
    setLoading(true)
    setFailed(false)
    try {
      const result = await loadArtifact(taskId, artifactId)
      setFailed(!result.ok)
    } catch {
      // The handler always resolves with a closed code; this is defense in depth
      // against an unexpected preload-layer rejection.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-3">
      <Button size="sm" variant="outline" onClick={() => void handleToggle()}>
        {expanded
          ? translate('auto.components.auditedWorkflow.plan.hidePlan', 'Hide plan')
          : translate('auto.components.auditedWorkflow.plan.showPlan', 'Show plan')}
      </Button>

      {expanded ? (
        <div className="mt-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.auditedWorkflow.plan.loading', 'Loading plan…')}
            </p>
          ) : failed ? (
            <p className="text-xs text-destructive">
              {translate(
                'auto.components.auditedWorkflow.plan.loadFailed',
                'The plan could not be loaded.'
              )}
            </p>
          ) : (
            <>
              <div className="max-h-96 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 scrollbar-sleek">
                <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                  {body ?? ''}
                </pre>
              </div>
              {/* Stated plainly: the human is reading a processed document, and
                  should know where it differs from what the model wrote. */}
              {redactionCount > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.auditedWorkflow.plan.redacted',
                    '{count} values were redacted.'
                  ).replace('{count}', String(redactionCount))}
                </p>
              ) : null}
              {truncated ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.auditedWorkflow.plan.truncated',
                    'The plan was truncated.'
                  )}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
