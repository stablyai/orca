import React, { useEffect, useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Plus, X } from 'lucide-react'
import type {
  DockerConnection,
  DockerContainerInspect,
  DockerContainerSummary
} from '../../../../shared/docker-types'
import { buildDockerTerminalCommand } from './docker-terminal-command'
import { DockerEmbeddedTerminal } from './DockerEmbeddedTerminal'
import { DockerContainerActions } from './DockerContainerActions'

export function DockerContainerDetail({
  container,
  connection,
  inspect,
  inspectError
}: {
  container: DockerContainerSummary | null
  connection: DockerConnection
  inspect: DockerContainerInspect | null
  inspectError: string | null
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState('details')
  const [terminalIds, setTerminalIds] = useState<number[]>([1])
  // Tracks the next id to assign; starts at 2 since id 1 is pre-seeded above.
  const nextId = useRef(2)

  // Reset terminal state when the container changes so stale PTY keys don't
  // linger across container selections, but preserve non-terminal active tabs.
  useEffect(() => {
    setTerminalIds([1])
    nextId.current = 2
    setActiveTab((prev) => (prev.startsWith('terminal-') ? 'terminal-1' : prev))
  }, [container?.id])

  function addTerminal(): void {
    const id = nextId.current++
    setTerminalIds((prev) => [...prev, id])
    setActiveTab(`terminal-${id}`)
  }

  function closeTerminal(id: number): void {
    setTerminalIds((prev) => {
      const next = prev.filter((t) => t !== id)
      // If the closed terminal was active, switch to the nearest remaining one
      // or fall back to 'logs' when no terminals are left.
      setActiveTab((current) => {
        if (current !== `terminal-${id}`) return current
        if (next.length === 0) return 'logs'
        // Find the neighbour: prefer the one before, else the one after.
        const closedIndex = prev.indexOf(id)
        const neighbour = next[Math.max(0, closedIndex - 1)]
        return `terminal-${neighbour}`
      })
      return next
    })
  }

  if (!container) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {translate('auto.components.docker.DockerContainerDetail.dc6f85fe97', 'Select a container to see its details.')}
      </div>
    )
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full min-h-0 flex-col">
      {/* Persistent header: container name/status on the left, lifecycle actions on the right. */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {container.names[0] ?? container.id.slice(0, 12)}
          </span>
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.docker.DockerContainerDetail.3f56801f68', 'Status')}{': '}
            {container.status}
          </span>
        </div>
        <DockerContainerActions container={container} />
      </div>

      {/* Why: page-level tabs sit on a flat strip; the line variant paints an
          underline under the active tab so we don't need an extra boxing border. */}
      <TabsList
        variant="line"
        className="mx-0 w-full justify-start gap-2 border-b border-border/60 bg-transparent px-4"
      >
        <TabsTrigger value="details" className="px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.73a03cf4fc', 'Details')}
        </TabsTrigger>
        <TabsTrigger value="logs" className="px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.8e913f1e01', 'Logs')}
        </TabsTrigger>

        {/* One trigger per open terminal. The close affordance is a sibling span
            (not a nested button) to avoid invalid button-in-button HTML. */}
        {terminalIds.map((id, index) => (
          <div key={id} className="flex items-center">
            <TabsTrigger value={`terminal-${id}`} className="px-3 py-2.5 pr-1">
              {translate(
                'auto.components.docker.DockerContainerDetail.8b405f5f30',
                'Terminal ({{value0}})',
                { value0: index + 1 }
              )}
            </TabsTrigger>
            {/* span acts as the close button; stopPropagation prevents the
                enclosing TabsTrigger from receiving the click and re-selecting. */}
            <span
              role="button"
              tabIndex={0}
              aria-label="Close terminal"
              className="ml-0.5 flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(e) => {
                e.stopPropagation()
                closeTerminal(id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeTerminal(id)
                }
              }}
            >
              <X className="size-2.5" />
            </span>
          </div>
        ))}

        {/* "+" button to open an additional terminal. */}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open new terminal"
          onClick={addTerminal}
        >
          <Plus />
        </Button>

        <TabsTrigger value="env" className="px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.7b6a28f972', 'Env')}
        </TabsTrigger>
        <TabsTrigger value="mounts" className="px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.3785677742', 'Mounts & Ports')}
        </TabsTrigger>
      </TabsList>

      {/* Details tab */}
      <TabsContent value="details" className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{container.names[0] ?? container.id.slice(0, 12)}</span>
            <span className="font-mono text-xs text-muted-foreground">{container.image}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">State</dt>
            <dd>{container.state}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{container.status}</dd>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="font-mono">{container.id.slice(0, 12)}</dd>
            {container.composeProject ? (
              <>
                <dt className="text-muted-foreground">Compose</dt>
                <dd>{container.composeProject}</dd>
              </>
            ) : null}
            {inspect ? (
              <>
                <dt className="text-muted-foreground">
                  {translate('auto.components.docker.DockerContainerDetail.d3541f3e1d', 'Created')}
                </dt>
                <dd>{inspect.createdAt}</dd>
                <dt className="text-muted-foreground">
                  {translate('auto.components.docker.DockerContainerDetail.37810d101e', 'Restart policy')}
                </dt>
                <dd>{inspect.restartPolicy}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </TabsContent>

      {/* Logs tab — key forces remount (kills old PTY) when container or connection changes */}
      <TabsContent value="logs" className="min-h-0 flex-1">
        <DockerEmbeddedTerminal
          key={`logs:${container.id}`}
          {...buildDockerTerminalCommand(connection, 'logs', container.id)}
        />
      </TabsContent>

      {/* Terminal tabs — forceMount keeps each PTY alive across tab switches.
          The `hidden` class (display:none) hides inactive panes without
          unmounting them; revealing one triggers the ResizeObserver in
          useEmbeddedPtyTerminal to re-fit the xterm. Closing a terminal removes
          its id from terminalIds, which unmounts its TabsContent and kills the PTY. */}
      {terminalIds.map((id) => (
        <TabsContent
          key={id}
          value={`terminal-${id}`}
          forceMount
          className={cn('mt-0 min-h-0 flex-1', activeTab !== `terminal-${id}` && 'hidden')}
        >
          <DockerEmbeddedTerminal
            key={`${container.id}:term:${id}`}
            {...buildDockerTerminalCommand(connection, 'shell', container.id)}
          />
        </TabsContent>
      ))}

      {/* Env tab */}
      <TabsContent value="env" className="min-h-0 flex-1">
        {inspectError ? (
          <div className="p-4 text-xs text-destructive">{inspectError}</div>
        ) : inspect?.env && inspect.env.length > 0 ? (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 p-4 text-xs">
              {inspect.env.map((entry) => {
                // Split on the FIRST '=' only so values containing '=' are preserved.
                const eqIdx = entry.indexOf('=')
                const envKey = eqIdx >= 0 ? entry.slice(0, eqIdx) : entry
                const envVal = eqIdx >= 0 ? entry.slice(eqIdx + 1) : ''
                return (
                  <div key={envKey} className="flex gap-2">
                    <span className="font-mono text-muted-foreground">{envKey}</span>
                    <span className="font-mono">{envVal}</span>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            {translate('auto.components.docker.DockerContainerDetail.dcd88f653a', 'No environment variables.')}
          </div>
        )}
      </TabsContent>

      {/* Mounts & Ports tab */}
      <TabsContent value="mounts" className="min-h-0 flex-1">
        {inspectError ? (
          <div className="p-4 text-xs text-destructive">{inspectError}</div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-4 p-4 text-xs">
              {/* Mounts section */}
              <section className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">
                  {translate('auto.components.docker.DockerContainerDetail.f10977e945', 'Mounts')}
                </span>
                {inspect && inspect.mounts.length > 0 ? (
                  inspect.mounts.map((mount, i) => (
                    <div key={i} className="flex flex-col gap-0.5 rounded border border-border p-2">
                      <div className="flex gap-1">
                        <span className="font-mono text-muted-foreground">{mount.source}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-mono">{mount.destination}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {mount.mode}{mount.mode ? ' · ' : ''}{mount.rw ? 'rw' : 'ro'}
                      </span>
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground">
                    {translate('auto.components.docker.DockerContainerDetail.7d87fc3379', 'No mounts.')}
                  </span>
                )}
              </section>

              {/* Ports section */}
              <section className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">
                  {translate('auto.components.docker.DockerContainerDetail.618e10b649', 'Ports')}
                </span>
                {inspect && inspect.ports.length > 0 ? (
                  inspect.ports.map((port, i) => (
                    <div key={i} className="flex gap-1 rounded border border-border p-2">
                      <span className="font-mono">{port.containerPort}</span>
                      <span className="text-muted-foreground">→</span>
                      {port.hostPort ? (
                        <span className="font-mono">{port.hostIp ? `${port.hostIp}:` : ''}{port.hostPort}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {translate('auto.components.docker.DockerContainerDetail.23d6458b14', 'exposed')}
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground">
                    {translate('auto.components.docker.DockerContainerDetail.e8306d8d6e', 'No published ports.')}
                  </span>
                )}
              </section>
            </div>
          </ScrollArea>
        )}
      </TabsContent>
    </Tabs>
  )
}
