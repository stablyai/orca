import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { Translate } from '@/i18n/use-translate'
import type { AgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { formatAgentProductName } from '../../../../shared/agent-status/presentation/agent-type-label'

export type AgentHookConsentResultView =
  | { kind: 'done'; agents: AgentHookTarget[]; waiting: boolean }
  | { kind: 'failed'; agent: AgentHookTarget; detail: string }

export function agentNames(agents: readonly AgentHookTarget[]): string {
  return agents.map((agent) => formatAgentProductName(agent)).join(', ')
}

/** The card after Install: installed, approved but waiting for the CLI, or failed with Try again. */
export function AgentHookConsentResult({
  result: view,
  name,
  closeButton,
  onLater,
  onRetry,
  t
}: {
  result: AgentHookConsentResultView
  name: string
  closeButton: ReactNode
  onLater: () => void
  onRetry: () => void
  t: Translate
}): React.JSX.Element {
  const done = view.kind === 'done'
  return (
    <Card size="notice" role="complementary" className="overflow-hidden">
      <div className="p-2">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            {done ? (
              <CircleCheck className="size-4 text-status-success" />
            ) : (
              <CircleAlert className="size-4 text-destructive" />
            )}
          </span>
          <p role="status" className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {done && view.waiting
              ? t('agentHookConsent.approved', 'Hooks approved for {{agent}}', { agent: name })
              : done
                ? view.agents.length > 1
                  ? t('agentHookConsent.installedMany', 'Hooks installed for {{count}} agents', {
                      count: view.agents.length
                    })
                  : t('agentHookConsent.installed', 'Hooks installed for {{agent}}', {
                      agent: name
                    })
                : t('agentHookConsent.failed', 'Couldn’t install hooks for {{agent}}', {
                    // Install for all can fail on a companion; name the one that failed.
                    agent: formatAgentProductName(view.agent)
                  })}
          </p>
          {closeButton}
        </div>
        <p className="pr-2 pl-9 text-xs text-muted-foreground">
          {done && view.waiting
            ? t(
                'agentHookConsent.approvedNext',
                'Orca adds them where {{agent}} is installed, the next time it starts there.',
                { agent: name }
              )
            : done
              ? `${view.agents.length > 1 ? `${agentNames(view.agents)}. ` : ''}${t(
                  'agentHookConsent.installedNext',
                  'They apply the next time each one starts.'
                )}`
              : view.detail}
        </p>
        {done ? null : (
          <div className="flex items-center justify-end gap-1 px-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onLater}>
              {t('agentHookConsent.later', 'Later')}
            </Button>
            <Button type="button" size="sm" onClick={onRetry}>
              {t('agentHookConsent.retry', 'Try again')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}
