import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useTabAgent } from '@/lib/agent-session/tab-identity/use-tab-agent'
import { revealWorkerPane } from '@/lib/open-orchestration-worker'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { BoundWorker } from '../../../../../shared/orchestration/workers/worker-auto-close'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { boundWorkerLink } from './bound-worker-link'

// Splits the translated line at the worker's name, so each language keeps its own word order.
const NAME_SLOT = '\u0000'

/** On a terminal that closes with a worker: the worker's agent icon and its tab's name, a link that
 *  focuses the worker's pane while it has one, plain text once it is gone. */
export function BoundWorkerTitle({
  boundTo,
  countdown
}: {
  boundTo: BoundWorker
  countdown: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const link = boundWorkerLink(
    boundTo,
    tabsByWorktree,
    t('components.orchestration.workerAutoClose.boundFallbackName', 'its worker')
  )
  const line =
    countdown === null
      ? t('components.orchestration.workerAutoClose.boundRunning', 'Closes with {{worker}}', {
          worker: NAME_SLOT
        })
      : t(
          'components.orchestration.workerAutoClose.boundFinished',
          '{{worker}} finished · Closes in {{countdown}}',
          { worker: NAME_SLOT, countdown }
        )
  const [before, after = ''] = line.split(NAME_SLOT)
  const icon = link.tab ? (
    <TabAgentIcon tab={link.tab} />
  ) : boundTo.agent && isTuiAgent(boundTo.agent) ? (
    <AgentIcon agent={boundTo.agent} size={12} />
  ) : null
  const name = (
    <span className="max-w-64 truncate" title={link.name}>
      {link.name}
    </span>
  )
  const reveal = link.reveal
  return (
    <>
      {before}
      {reveal ? (
        <Button
          type="button"
          variant="link"
          size="inlineInherit"
          className="max-w-full align-bottom text-foreground"
          onClick={() => revealWorkerPane(reveal.worktreeId, reveal.paneKey)}
        >
          {icon}
          {name}
        </Button>
      ) : (
        <span className="inline-flex max-w-full items-center gap-1 align-bottom">
          {icon}
          {name}
        </span>
      )}
      {after}
    </>
  )
}

function TabAgentIcon({ tab }: { tab: TerminalTab }): React.JSX.Element | null {
  const agent = useTabAgent(tab)
  return agent ? <AgentIcon agent={agent} size={12} /> : null
}
