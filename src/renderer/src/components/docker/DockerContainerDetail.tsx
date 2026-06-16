import React from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Terminal, X } from 'lucide-react'
import type {
  DockerConnection,
  DockerContainerInspect,
  DockerContainerSummary
} from '../../../../shared/docker-types'
import { buildDockerTerminalCommand } from './docker-terminal-command'
import { DockerEmbeddedTerminal } from './DockerEmbeddedTerminal'
import { DockerContainerActions } from './DockerContainerActions'
import { useAppStore } from '@/store'

// Stable empty default avoids a new object reference on every render when a
// container has no tab state entry yet, preventing unnecessary re-renders.
const EMPTY_TAB_STATE = { terminalIds: [] as number[], activeTab: 'details' }

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
  // All store selectors run unconditionally (hooks rule); the container guard is
  // inside the selector so hook call order is always stable.
  const tabState =
    useAppStore((s) => (container ? s.dockerContainerTabState[container.id] : undefined)) ??
    EMPTY_TAB_STATE
  const setActiveTab = useAppStore((s) => s.setDockerContainerActiveTab)
  const addDockerContainerTerminal = useAppStore((s) => s.addDockerContainerTerminal)
  const closeDockerContainerTerminal = useAppStore((s) => s.closeDockerContainerTerminal)

  if (!container) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {translate('auto.components.docker.DockerContainerDetail.dc6f85fe97', 'Select a container to see its details.')}
      </div>
    )
  }

  // The embedded PTY's screen-clear command is shell-specific (cmd.exe rejects
  // `clear`), so the host platform selects the right one for local/tcp terminals.
  const hostPlatform = window.api.platform.get().platform

  return (
    <Tabs
      value={tabState.activeTab}
      onValueChange={(t) => setActiveTab(container.id, t)}
      className="flex h-full min-h-0 flex-col"
    >
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
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={() => addDockerContainerTerminal(container.id)}>
            <Terminal />
            {translate('auto.components.docker.DockerContainerDetail.65267b5ce5', 'Terminal')}
          </Button>
          <DockerContainerActions container={container} />
        </div>
      </div>

      {/* Why: page-level tabs sit on a flat strip; the line variant paints an
          underline under the active tab so we don't need an extra boxing border. */}
      <TabsList
        variant="line"
        className="mx-0 w-full justify-start gap-2 border-b border-border/60 bg-transparent px-4"
      >
        <TabsTrigger value="details" className="flex-1 px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.73a03cf4fc', 'Details')}
        </TabsTrigger>
        <TabsTrigger value="logs" className="flex-1 px-3 py-2.5">
          {translate('auto.components.docker.DockerContainerDetail.8e913f1e01', 'Logs')}
        </TabsTrigger>

        {/* One trigger per open terminal. The close affordance is a sibling span
            (not a nested button) to avoid invalid button-in-button HTML. */}
        {tabState.terminalIds.map((id, index) => (
          <div key={id} className="flex min-w-0 flex-1 items-center">
            <TabsTrigger value={`terminal-${id}`} className="min-w-0 flex-1 px-3 py-2.5 pr-1">
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
              aria-label={translate('auto.components.docker.DockerContainerDetail.fc5533a07d', 'Close terminal')}
              className="ml-0.5 flex size-4 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(e) => {
                e.stopPropagation()
                closeDockerContainerTerminal(container.id, id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeDockerContainerTerminal(container.id, id)
                }
              }}
            >
              <X className="size-2.5" />
            </span>
          </div>
        ))}
      </TabsList>

      {/* Details tab — env, ports, and mounts are folded in as stacked sections
          below the definition list, PhpStorm-style. The pane is already
          overflow-y-auto so no extra ScrollArea is needed. */}
      <TabsContent value="details" className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{container.names[0] ?? container.id.slice(0, 12)}</span>
            <span className="font-mono text-xs text-muted-foreground">{container.image}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">
              {translate('auto.components.docker.DockerContainerDetail.a76923f400', 'State')}
            </dt>
            <dd>{container.state}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.docker.DockerContainerDetail.3f56801f68', 'Status')}
            </dt>
            <dd>{container.status}</dd>
            <dt className="text-muted-foreground">
              {translate('auto.components.docker.DockerContainerDetail.f30fa89199', 'ID')}
            </dt>
            <dd className="font-mono">{container.id.slice(0, 12)}</dd>
            {container.composeProject ? (
              <>
                <dt className="text-muted-foreground">
                  {translate('auto.components.docker.DockerContainerDetail.fd2b310c03', 'Compose')}
                </dt>
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

          {/* Environment variables section */}
          <section className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground uppercase tracking-wide text-xs">
              {translate('auto.components.docker.DockerContainerDetail.9624eeb3d3', 'Environment variables')}
            </span>
            {inspectError ? (
              <div className="text-xs text-destructive">{inspectError}</div>
            ) : inspect?.env && inspect.env.length > 0 ? (
              <div className="flex flex-col gap-1 text-xs">
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
            ) : (
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.docker.DockerContainerDetail.dcd88f653a', 'No environment variables.')}
              </span>
            )}
          </section>

          {/* Ports section */}
          <section className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground uppercase tracking-wide text-xs">
              {translate('auto.components.docker.DockerContainerDetail.618e10b649', 'Ports')}
            </span>
            {inspectError ? (
              <div className="text-xs text-destructive">{inspectError}</div>
            ) : inspect && inspect.ports.length > 0 ? (
              <div className="flex flex-col gap-1 text-xs">
                {inspect.ports.map((port, i) => (
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
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.docker.DockerContainerDetail.e8306d8d6e', 'No published ports.')}
              </span>
            )}
          </section>

          {/* Mounts section */}
          <section className="flex flex-col gap-1">
            <span className="font-medium text-muted-foreground uppercase tracking-wide text-xs">
              {translate('auto.components.docker.DockerContainerDetail.f10977e945', 'Mounts')}
            </span>
            {inspectError ? (
              <div className="text-xs text-destructive">{inspectError}</div>
            ) : inspect && inspect.mounts.length > 0 ? (
              <div className="flex flex-col gap-1 text-xs">
                {inspect.mounts.map((mount, i) => (
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
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.docker.DockerContainerDetail.7d87fc3379', 'No mounts.')}
              </span>
            )}
          </section>
        </div>
      </TabsContent>

      {/* Logs tab — key forces remount (kills old PTY) when container or connection changes.
          readOnly: the log stream is display-only; keyboard input must not reach the PTY. */}
      <TabsContent value="logs" className="min-h-0 flex-1">
        <DockerEmbeddedTerminal
          key={`logs:${container.id}`}
          {...buildDockerTerminalCommand(connection, 'logs', container.id, 'docker', hostPlatform)}
          readOnly
        />
      </TabsContent>

      {/* Terminal tabs — forceMount keeps each PTY alive across tab switches.
          The `hidden` class (display:none) hides inactive panes without
          unmounting them; revealing one triggers the ResizeObserver in
          useEmbeddedPtyTerminal to re-fit the xterm. Closing a terminal removes
          its id from terminalIds, which unmounts its TabsContent and kills the PTY. */}
      {tabState.terminalIds.map((id) => (
        <TabsContent
          key={id}
          value={`terminal-${id}`}
          forceMount
          className={cn('mt-0 min-h-0 flex-1', tabState.activeTab !== `terminal-${id}` && 'hidden')}
        >
          <DockerEmbeddedTerminal
            key={`${container.id}:term:${id}`}
            {...buildDockerTerminalCommand(connection, 'shell', container.id, 'docker', hostPlatform)}
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}
