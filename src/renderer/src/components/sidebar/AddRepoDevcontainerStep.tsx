import React, { useEffect, useState } from 'react'
import { Container } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { DevcontainerInfo } from '../../../../shared/devcontainer-types'

type DevcontainerStepProps = {
  onSelect: (info: DevcontainerInfo) => void
}

/** Derive a short client label (the last path segment) from the host folder. */
function clientName(hostFolder: string): string {
  return hostFolder.split('/').filter(Boolean).at(-1) ?? hostFolder
}

/**
 * Add-Project "Devcontainer" source: lists running/known devcontainers (via the
 * `devcontainer:list` IPC) and lets the user open one as a project. Selecting a
 * container hands the {@link DevcontainerInfo} back to the dialog, which creates
 * a repo bound to the host folder + devcontainer execution host.
 */
export function AddRepoDevcontainerStep({ onSelect }: DevcontainerStepProps): React.JSX.Element {
  const [items, setItems] = useState<DevcontainerInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.devcontainer
      .list()
      .then((list) => {
        if (!cancelled) {
          setItems(list)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(String(err))
          setItems([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.sidebar.AddRepoDevcontainerStep.title',
            'Open a devcontainer'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRepoDevcontainerStep.description',
            'Pick a running devcontainer to manage as a project. Files and git stay on your machine; the agent runs inside the container.'
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-2" data-testid="devcontainer-list">
        {items === null ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddRepoDevcontainerStep.loading',
              'Loading devcontainers…'
            )}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {error
              ? translate(
                  'auto.components.sidebar.AddRepoDevcontainerStep.error',
                  'Could not reach Docker. Make sure Docker/OrbStack is running.'
                )
              : translate(
                  'auto.components.sidebar.AddRepoDevcontainerStep.empty',
                  'No devcontainers found. Start one (e.g. “Reopen in Container”) and try again.'
                )}
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-input bg-background">
            {items.map((info, index) => (
              <button
                key={info.containerId}
                type="button"
                data-testid="devcontainer-item"
                onClick={() => onSelect(info)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent ${
                  index > 0 ? 'border-t border-border/70' : ''
                }`}
              >
                <Container className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {clientName(info.hostFolder)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {info.hostFolder}
                    {info.running ? '' : ' · stopped'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
