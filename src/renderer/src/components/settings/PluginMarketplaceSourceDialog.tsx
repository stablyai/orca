import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type PluginMarketplaceSourceDialogProps = {
  open: boolean
  sources: readonly PluginMarketplaceHostSourceState[]
  onOpenChange: (open: boolean) => void
  onChanged: () => Promise<void>
}

function sourceError(cause: unknown, fallback: string): string {
  console.warn('[plugins] marketplace source action failed:', cause)
  return fallback
}

export function PluginMarketplaceSourceDialog({
  open,
  sources,
  onOpenChange,
  onChanged
}: PluginMarketplaceSourceDialogProps): React.JSX.Element {
  const urlRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [gitRef, setGitRef] = useState('main')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setBusyAction(null)
      setError(null)
    }
  }, [open])

  const add = async (): Promise<void> => {
    if (!url.trim() || !gitRef.trim() || busyAction) {
      return
    }
    setBusyAction('add')
    setError(null)
    try {
      await window.api.plugins.addMarketplace({
        kind: 'git',
        url: url.trim(),
        ref: gitRef.trim()
      })
      setUrl('')
      setGitRef('main')
      await onChanged()
    } catch (cause) {
      setError(
        sourceError(
          cause,
          translate(
            'auto.components.settings.PluginMarketplaceSourceDialog.addFailed',
            'Could not add this marketplace. Check the Git URL, ref, and your Git credentials.'
          )
        )
      )
    } finally {
      setBusyAction(null)
    }
  }

  const refresh = async (sourceId: string): Promise<void> => {
    setBusyAction(`refresh:${sourceId}`)
    setError(null)
    try {
      await window.api.plugins.refreshMarketplaces({ sourceId })
      await onChanged()
    } catch (cause) {
      setError(
        sourceError(
          cause,
          translate(
            'auto.components.settings.PluginMarketplaceSourceDialog.refreshFailed',
            'Could not refresh this marketplace. Its last valid cached index is still available.'
          )
        )
      )
    } finally {
      setBusyAction(null)
    }
  }

  const remove = async (sourceId: string): Promise<void> => {
    setBusyAction(`remove:${sourceId}`)
    setError(null)
    try {
      await window.api.plugins.removeMarketplace({ sourceId })
      await onChanged()
    } catch (cause) {
      setError(
        sourceError(
          cause,
          translate(
            'auto.components.settings.PluginMarketplaceSourceDialog.removeFailed',
            'Could not remove this marketplace.'
          )
        )
      )
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busyAction && onOpenChange(nextOpen)}>
      <DialogContent
        className="plugin-security-chrome max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          urlRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.PluginMarketplaceSourceDialog.title',
              'Marketplace sources'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginMarketplaceSourceDialog.description',
              'Marketplaces are pinned Git repositories. Orca uses your existing system Git credentials for private repositories.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="space-y-1">
            <Label htmlFor="plugin-marketplace-url">
              {translate(
                'auto.components.settings.PluginMarketplaceSourceDialog.urlLabel',
                'Git URL'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginMarketplaceSourceDialog.urlDescription',
                'Use an HTTPS or SSH repository URL containing orca-marketplace.json.'
              )}
            </p>
          </div>
          <Input
            ref={urlRef}
            id="plugin-marketplace-url"
            value={url}
            disabled={Boolean(busyAction)}
            placeholder={translate(
              'auto.components.settings.PluginMarketplaceSourceDialog.urlPlaceholder',
              'https://git.example.com/team/plugins.git'
            )}
            onChange={(event) => setUrl(event.target.value)}
          />
          <div className="space-y-1">
            <Label htmlFor="plugin-marketplace-ref">
              {translate(
                'auto.components.settings.PluginMarketplaceSourceDialog.refLabel',
                'Git ref'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PluginMarketplaceSourceDialog.refDescription',
                'Choose a branch, tag, or commit. Every fetched index is recorded at an exact commit.'
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              id="plugin-marketplace-ref"
              value={gitRef}
              disabled={Boolean(busyAction)}
              onChange={(event) => setGitRef(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void add()
                }
              }}
            />
            <Button
              className="w-28"
              disabled={Boolean(busyAction) || !url.trim() || !gitRef.trim()}
              onClick={() => void add()}
            >
              {busyAction === 'add' ? <Loader2 className="animate-spin" /> : null}
              {busyAction === 'add'
                ? translate(
                    'auto.components.settings.PluginMarketplaceSourceDialog.adding',
                    'Adding…'
                  )
                : translate(
                    'auto.components.settings.PluginMarketplaceSourceDialog.add',
                    'Add source'
                  )}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'auto.components.settings.PluginMarketplaceSourceDialog.configured',
              'Configured sources'
            )}
          </p>
          {sources.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
              {translate(
                'auto.components.settings.PluginMarketplaceSourceDialog.empty',
                'No marketplace sources configured.'
              )}
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              {sources.map((source) => {
                const refreshing = busyAction === `refresh:${source.id}`
                const removing = busyAction === `remove:${source.id}`
                return (
                  <div
                    key={source.id}
                    className="flex items-start gap-3 px-3.5 py-3 [&+&]:border-t [&+&]:border-border/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {source.marketplace?.name ?? source.source.url}
                        {source.official ? (
                          <Badge variant="outline" className="ml-2 align-middle">
                            {translate(
                              'auto.components.settings.PluginMarketplaceSourceDialog.official',
                              'Official'
                            )}
                          </Badge>
                        ) : null}
                      </p>
                      {source.marketplace ? (
                        <p className="text-xs text-muted-foreground">
                          {translate(
                            'auto.components.settings.PluginMarketplaceSourceDialog.owner',
                            'Owner: {{value0}}',
                            { value0: source.marketplace.owner }
                          )}
                        </p>
                      ) : null}
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {source.source.url}#{source.source.ref}
                      </p>
                      {source.marketplace ? (
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.settings.PluginMarketplaceSourceDialog.pinnedCommit',
                            'Pinned at {{value0}}',
                            { value0: source.marketplace.resolvedCommit }
                          )}
                        </p>
                      ) : null}
                      {source.stale ? (
                        <p className="mt-1 text-xs text-destructive">
                          {translate(
                            'auto.components.settings.PluginMarketplaceSourceDialog.stale',
                            'Refresh failed. Browsing the last valid cached index.'
                          )}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={Boolean(busyAction)}
                      aria-label={translate(
                        'auto.components.settings.PluginMarketplaceSourceDialog.refreshLabel',
                        'Refresh {{value0}}',
                        { value0: source.marketplace?.name ?? source.source.url }
                      )}
                      onClick={() => void refresh(source.id)}
                    >
                      <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
                    </Button>
                    {!source.official ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={Boolean(busyAction)}
                        aria-label={translate(
                          'auto.components.settings.PluginMarketplaceSourceDialog.removeLabel',
                          'Remove {{value0}}',
                          { value0: source.marketplace?.name ?? source.source.url }
                        )}
                        onClick={() => void remove(source.id)}
                      >
                        {removing ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Trash2 className="text-destructive" />
                        )}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={Boolean(busyAction)}
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.components.settings.PluginMarketplaceSourceDialog.done', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
