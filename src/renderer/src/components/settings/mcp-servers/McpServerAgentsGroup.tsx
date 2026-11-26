// A server page's Agents: a switch per installed agent. Grok, Cursor and Droid only read their own MCP
// file, so the first switch turned on for one asks once before Orca keeps servers in that file.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { McpAgentFiles, McpFileAgent } from '../../../../../shared/mcp-servers/mcp-servers'
import {
  allowMcpAgentFile,
  setMcpServerAgent,
  type McpAgentProblem,
  type McpServerView
} from '@/runtime/mcp-servers/mcp-servers-client'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { isMcpFileAgent } from './mcp-server-agents'
import { mcpAgentLabel, mcpAgentProblemText, mcpServerTitle } from './mcp-server-words'
import { showMcpServerChangeToast } from './mcp-server-change-toast'

// Each agent's own MCP file, as the consent names it.
const AGENT_FILES: Record<McpFileAgent, string> = {
  grok: '~/.grok/config.toml',
  cursor: '~/.cursor/mcp.json',
  droid: '~/.factory/mcp.json'
}

/** The consent's answer; `settle` runs however it ends, so the waiting switch lets go. */
async function askFileConsent(ask: () => Promise<boolean>, settle: () => void): Promise<boolean> {
  try {
    return await ask()
  } finally {
    settle()
  }
}

function changeTitle(server: McpServerView, agents: string[], on: boolean, t: Translate): string {
  const name = mcpServerTitle(server.name)
  if (agents.length !== 1) {
    return on
      ? t('settings.mcpServers.toast.allOn', '{{name}} turned on for every agent', { name })
      : t('settings.mcpServers.toast.allOff', '{{name}} turned off for every agent', { name })
  }
  const agent = mcpAgentLabel(agents[0] ?? '')
  return on
    ? t('settings.mcpServers.toast.agentOn', '{{name}} turned on for {{agent}}', { name, agent })
    : t('settings.mcpServers.toast.agentOff', '{{name}} turned off for {{agent}}', { name, agent })
}

export function McpServerAgentsGroup({
  target,
  server,
  agents,
  agentFiles,
  agentProblems
}: {
  target: RuntimeClientTarget
  server: McpServerView
  agents: readonly TuiAgent[]
  agentFiles: McpAgentFiles
  agentProblems: Record<string, McpAgentProblem> | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  // The agent whose switch waits on its file consent.
  const [asking, setAsking] = useState<string | null>(null)
  // One change at a time: a second click builds on what the first left, not on what the page showed.
  const [busy, setBusy] = useState(false)
  const isOn = (agent: string): boolean => !server.agentsOff.includes(agent)
  const allOn = agents.every(isOn)

  /** Lets Orca keep servers in the agent's own file first, when it never has. */
  const consented = async (agent: string): Promise<boolean> => {
    if (!isMcpFileAgent(agent) || agentFiles[agent]) {
      return true
    }
    const label = getAgentLabel(agent)
    setAsking(agent)
    const ok = await askFileConsent(
      () =>
        confirm({
          title: t('settings.mcpServers.fileAgent.title', 'Let Orca edit {{agent}}’s MCP file?', {
            agent: label
          }),
          description: t(
            'settings.mcpServers.fileAgent.line',
            'Orca will keep your MCP servers in {{agent}}’s settings file ({{file}}). Your own entries stay as they are.',
            { agent: label, file: AGENT_FILES[agent] }
          ),
          confirmLabel: t('settings.mcpServers.fileAgent.allow', 'Allow'),
          surface: 'security'
        }).then(async (allowed) => {
          if (allowed) {
            await allowMcpAgentFile(target, agent, true)
          }
          return allowed
        }),
      () => setAsking(null)
    )
    return ok
  }

  const turn = async (changing: string[], on: boolean): Promise<void> => {
    const changed: string[] = []
    for (const agent of changing) {
      if (on && !(await consented(agent))) {
        continue
      }
      await setMcpServerAgent(target, server.id, agent, on)
      changed.push(agent)
    }
    if (changed.length > 0) {
      await showMcpServerChangeToast(target, changeTitle(server, changed, on, t))
    }
  }
  const run = (changing: string[], on: boolean): void => {
    setBusy(true)
    void turn(changing, on)
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setBusy(false))
  }

  return (
    <SettingsGroup
      title={t('settings.mcpServers.agents.title', 'Agents')}
      action={
        agents.length > 1 ? (
          <Button
            variant="link-muted"
            size="inlineText"
            disabled={busy}
            onClick={() =>
              run(
                agents.filter((agent) => isOn(agent) === allOn),
                !allOn
              )
            }
          >
            {allOn
              ? t('settings.mcpServers.agents.allOff', 'Turn all off')
              : t('settings.mcpServers.agents.allOn', 'Turn all on')}
          </Button>
        ) : undefined
      }
    >
      {agents.map((agent) => {
        const label = getAgentLabel(agent)
        const problem = agentProblems?.[agent]
        return (
          <div key={agent} data-settings-row="" className="flex min-h-11 items-center gap-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
              <AgentIcon agent={agent} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{label}</span>
              {problem ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      problem.kind === 'blocked' ? 'bg-status-warning' : 'bg-muted-foreground/40'
                    )}
                  />
                  <span className="truncate">{mcpAgentProblemText(agent, problem, t)}</span>
                </span>
              ) : null}
            </span>
            <Switch
              checked={isOn(agent) || asking === agent}
              pending={asking === agent ? 'turning-on' : undefined}
              disabled={busy && asking !== agent}
              aria-label={label}
              onCheckedChange={(on) => run([agent], on)}
            />
          </div>
        )
      })}
    </SettingsGroup>
  )
}
