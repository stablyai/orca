import { Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { formatBytes } from '@/components/status-bar/workspace-space-format'
import type { ActionsRepositoryOption } from '@/components/right-sidebar/use-actions-repositories'
import { ACTIONS_ARTIFACT_MAX_BYTES } from '../../../../../../shared/github/actions-artifact-types'
import { useActionsArtifacts } from './use-actions-artifacts'
/** Show artifact availability and save progress while keeping canceled transfers neutral and retriable failures visible. */
export function ActionsArtifacts({
  option,
  runId
}: {
  option: ActionsRepositoryOption
  runId: number
}) {
  const model = useActionsArtifacts(option, runId)
  return (
    <section
      className="rounded-md border border-border"
      aria-label={translate('actions.artifacts.title', 'Artifacts')}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">
          {translate('actions.artifacts.title', 'Artifacts')}
          {model.data?.totalCount !== null && model.data?.totalCount !== undefined
            ? ` (${model.data.totalCount})`
            : ''}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={model.loading}
          aria-label={translate('actions.artifacts.refresh', 'Refresh artifacts')}
          onClick={model.refresh}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <div className="space-y-3 p-4">
        {model.loading && (
          <p role="status" className="text-xs text-muted-foreground">
            {translate('actions.artifacts.loading', 'Loading artifacts…')}
          </p>
        )}
        {model.error && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{model.error}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={model.loading}
              onClick={model.data?.hasNextPage ? model.more : model.refresh}
            >
              {translate('actions.retry', 'Retry')}
            </Button>
          </div>
        )}
        {model.data && !model.loading && !model.error && model.data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {translate('actions.artifacts.empty', 'No artifacts are available for this run.')}
          </p>
        )}
        {model.data?.items.map((artifact) => {
          const expired = artifact.expired
          const tooLarge = artifact.sizeBytes > ACTIONS_ARTIFACT_MAX_BYTES
          return (
            <div
              key={artifact.id}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border/50 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium">{artifact.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatBytes(artifact.sizeBytes)}
                  {artifact.expiresAt
                    ? ` · ${translate('actions.artifacts.expires', 'Expires')} ${new Date(artifact.expiresAt).toLocaleString()}`
                    : ''}
                </p>
                {tooLarge && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {translate(
                      'actions.artifacts.large',
                      'Over 64 MiB. Use Open run on GitHub to download.'
                    )}
                  </p>
                )}
              </div>
              {expired && (
                <Badge variant="outline">{translate('actions.artifacts.expired', 'Expired')}</Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={expired || tooLarge || model.download.id !== null}
                aria-label={translate('actions.artifacts.downloadName', 'Download {{name}}', {
                  name: artifact.name
                })}
                onClick={() => {
                  void model.save(artifact)
                }}
              >
                <Download className="size-4" />
                {model.download.id === artifact.id
                  ? `${model.download.percent}%`
                  : translate('actions.artifacts.download', 'Download ZIP')}
              </Button>
            </div>
          )
        })}
        {model.data?.hasNextPage && (
          <Button variant="outline" size="sm" disabled={model.loading} onClick={model.more}>
            {translate('actions.artifacts.more', 'Load more artifacts')}
          </Button>
        )}
        {model.data?.limitReached && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'actions.artifacts.limit',
              'Showing up to 1,000 artifacts. Open the run on GitHub for more.'
            )}
          </p>
        )}
        {model.download.id !== null && (
          <div className="flex items-center gap-3">
            <p role="status" className="text-xs text-muted-foreground">
              {translate('actions.artifacts.saving', 'Downloading ZIP…')} {model.download.percent}%
            </p>
            <Button variant="outline" size="sm" onClick={model.cancel}>
              {translate('actions.artifacts.cancel', 'Cancel download')}
            </Button>
          </div>
        )}
        {model.download.error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {model.download.error}
          </p>
        )}
        {model.download.saved && (
          <p role="status" className="break-all text-xs text-muted-foreground">
            {translate('actions.artifacts.saved', 'Saved ZIP to {{path}}', {
              path: model.download.saved
            })}
          </p>
        )}
      </div>
    </section>
  )
}
