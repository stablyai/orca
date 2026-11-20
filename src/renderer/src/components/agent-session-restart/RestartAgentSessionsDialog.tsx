import { useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  answerRestartAgentSessionsPrompt,
  getRestartAgentSessionsPrompt,
  isCheckedByDefault,
  subscribeRestartAgentSessionsPrompt,
  type RestartAgentSessionsPrompt
} from '@/lib/agent-session/manual-restart/restart-agent-sessions-prompt'
import type {
  AgentRestartCandidate,
  AgentRestartCantReason
} from '@/lib/agent-session/manual-restart/local-agent-restart-candidates'
import { AgentSessionRow, AgentSessionTree, type AgentSessionTreeGroup } from './AgentSessionTree'

export default function RestartAgentSessionsDialog(): React.JSX.Element | null {
  const prompt = useSyncExternalStore(
    subscribeRestartAgentSessionsPrompt,
    getRestartAgentSessionsPrompt,
    getRestartAgentSessionsPrompt
  )
  // Reset the ticks for each new scan.
  return prompt ? <RestartAgentSessionsPromptDialog key={prompt.id} prompt={prompt} /> : null
}

export function RestartAgentSessionsPromptDialog({
  prompt
}: {
  prompt: RestartAgentSessionsPrompt
}): React.JSX.Element {
  const t = useTranslate()
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(prompt.candidates.filter(isCheckedByDefault).map((candidate) => candidate.ptyId))
  )
  const chosen = prompt.candidates
    .filter((candidate) => candidate.restartable && ticked.has(candidate.ptyId))
    .map((candidate) => candidate.ptyId)
  const toggle = (ptyId: string, checked: boolean): void => {
    setTicked((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(ptyId)
      } else {
        next.delete(ptyId)
      }
      return next
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          answerRestartAgentSessionsPrompt('cancel')
        }
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('agentSessionRestart.title', 'Restart agent sessions')}</DialogTitle>
          <DialogDescription>
            {t(
              'agentSessionRestart.body',
              'Restarting continues each conversation in a new process, for example after updating an agent CLI. Only sessions that look finished are checked. Restarting a busy session stops its current work.'
            )}
          </DialogDescription>
        </DialogHeader>
        <AgentSessionTree
          label={t('agentSessionRestart.listLabel', 'Agent sessions to restart')}
          groups={sessionGroups(prompt.candidates, t)}
          selected={ticked}
          onToggle={toggle}
          renderSession={(candidate, fixed) => (
            <AgentSessionRow
              session={candidate}
              agent={candidate.agent}
              fallbackTitle={t('agentSessionRestart.session', '{{agent}} session', {
                agent: formatAgentTypeLabel(candidate.agent)
              })}
              busy={!candidate.quiet}
              reason={candidate.restartable ? undefined : cantRestartLabel(candidate.reason, t)}
              fixed={fixed}
              checked={ticked.has(candidate.ptyId)}
              onToggle={toggle}
            />
          )}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => answerRestartAgentSessionsPrompt('cancel')}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={chosen.length === 0}
            onClick={() => answerRestartAgentSessionsPrompt('restart', chosen)}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('agentSessionRestart.restart', 'Restart {{count}} sessions', {
              count: chosen.length,
              defaultValue_one: 'Restart {{count}} session'
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One group per agent, in the order sessions were found, then everything that can't restart. */
function sessionGroups(
  candidates: readonly AgentRestartCandidate[],
  t: Translate = translate
): AgentSessionTreeGroup<AgentRestartCandidate>[] {
  const byAgent = new Map<string, AgentRestartCandidate[]>()
  for (const candidate of candidates) {
    if (candidate.restartable) {
      byAgent.set(candidate.agent, [...(byAgent.get(candidate.agent) ?? []), candidate])
    }
  }
  const groups: AgentSessionTreeGroup<AgentRestartCandidate>[] = [...byAgent].map(
    ([agent, sessions]) => ({ key: agent, title: formatAgentTypeLabel(agent), sessions })
  )
  const cantRestart = candidates.filter((candidate) => !candidate.restartable)
  if (cantRestart.length > 0) {
    groups.push({
      key: 'cant-restart',
      title: t('agentSessionRestart.groupCantRestart', "Can't restart"),
      sessions: cantRestart,
      fixed: true
    })
  }
  return groups
}

function cantRestartLabel(reason: AgentRestartCantReason, t: Translate = translate): string {
  switch (reason) {
    case 'no-session':
      return t('agentSessionRestart.reasonNoSession', 'No conversation to resume')
    case 'shared-session':
      return t('accounts.claude.switchSessions.reasonSharedSession', 'Also open in another pane')
    case 'wsl-terminal':
      return t('accounts.claude.switchSessions.reasonWsl', 'WSL terminal')
    case 'agent-teams-lead':
      return t('agentSessionRestart.reasonAgentTeamsLead', 'Agent Teams lead')
    case 'own-folder':
      return t('accounts.claude.switchSessions.reasonOwnFolder', 'Uses your own Claude folder')
    case 'couldnt-check':
      return t('agentSessionRestart.reasonCouldntCheck', "Couldn't check")
    case 'no-cwd':
      return t('agentSessionRestart.reasonNoCwd', 'Work folder unknown')
    case 'other-account':
      return t('agentSessionRestart.reasonOtherAccount', 'Would move to another account')
  }
}
