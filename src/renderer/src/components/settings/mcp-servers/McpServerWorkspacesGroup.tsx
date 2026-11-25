// A server page's Workspaces: one checklist of the host's repos and folders, then the ones added
// later. Everything checked reads "All workspaces", one unchecked "All but …", later off "Only …".
import React, { useRef, useState } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslate } from '@/i18n/use-translate'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { McpServerWorkspaces } from '../../../../../shared/mcp-servers/mcp-servers'
import {
  setMcpServerWorkspaces,
  type McpServerView
} from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type { McpHostWorkspace } from './use-mcp-host-workspaces'
import {
  isMcpWorkspaceOn,
  summarizeMcpWorkspaces,
  withMcpWorkspace,
  withMcpWorkspacesLater
} from './mcp-server-workspace-choice'
import { mcpServerTitle, mcpWorkspacesSummaryText } from './mcp-server-words'
import { showMcpServerChangeToast } from './mcp-server-change-toast'

function CheckRow({
  id,
  checked,
  onChange,
  children
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-settings-row="" className="flex min-h-11 items-center gap-3 py-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {children}
      </label>
    </div>
  )
}

export function McpServerWorkspacesGroup({
  target,
  server,
  workspaces
}: {
  target: RuntimeClientTarget
  server: McpServerView
  workspaces: readonly McpHostWorkspace[]
}): React.JSX.Element {
  const t = useTranslate()
  // Clicks made before the host answers build on each other, then save one after another, so a
  // second click never writes over the first with what the page showed before it.
  const [pending, setPending] = useState<McpServerWorkspaces | null>(null)
  const writes = useRef<{ tail: Promise<unknown>; count: number }>({
    tail: Promise.resolve(),
    count: 0
  })
  const chosen = pending ?? server.workspaces
  const summary = mcpWorkspacesSummaryText(summarizeMcpWorkspaces(chosen, workspaces), t)
  const save = (next: McpServerWorkspaces): void => {
    setPending(next)
    const queue = writes.current
    queue.count += 1
    queue.tail = queue.tail
      .then(() => setMcpServerWorkspaces(target, server.id, next))
      .then(
        (saved) =>
          showMcpServerChangeToast(
            target,
            t('settings.mcpServers.toast.workspaces', '{{name}}: {{workspaces}}', {
              name: mcpServerTitle(server.name),
              workspaces: mcpWorkspacesSummaryText(
                summarizeMcpWorkspaces(saved.workspaces, workspaces),
                t
              )
            })
          ),
        (error: unknown) => toast.error(botToolErrorMessage(error))
      )
      .finally(() => {
        queue.count -= 1
        if (queue.count === 0) {
          setPending(null)
        }
      })
  }
  return (
    <SettingsGroup
      title={t('settings.mcpServers.workspaces.title', 'Workspaces')}
      description={summary}
    >
      {workspaces.map((workspace) => (
        <CheckRow
          key={workspace.key}
          id={`mcp-workspace-${workspace.key}`}
          checked={isMcpWorkspaceOn(chosen, workspace.key)}
          onChange={(on) => save(withMcpWorkspace(chosen, workspace.key, on))}
        >
          {workspace.kind === 'repo' ? (
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{workspace.name}</span>
        </CheckRow>
      ))}
      <CheckRow
        id="mcp-workspaces-later"
        checked={chosen.later}
        onChange={(later) =>
          save(
            withMcpWorkspacesLater(
              chosen,
              workspaces.map((workspace) => workspace.key),
              later
            )
          )
        }
      >
        {t('settings.mcpServers.workspaces.later', 'Workspaces added later')}
      </CheckRow>
    </SettingsGroup>
  )
}
