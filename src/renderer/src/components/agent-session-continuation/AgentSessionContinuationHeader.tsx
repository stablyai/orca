import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

export function AgentSessionContinuationHeader({
  sourceName,
  sourceAgentLabel,
  canInterruptOriginal
}: {
  sourceName?: string
  sourceAgentLabel: string | null
  canInterruptOriginal: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const session =
    sourceName || t('components.agentSessionContinuation.untitledSession', 'Current session')
  const description = canInterruptOriginal
    ? sourceAgentLabel
      ? t('components.agentSessionContinuation.fromAgent', 'From {{agent}} · {{session}}', {
          agent: sourceAgentLabel,
          session
        })
      : session
    : sourceAgentLabel
      ? t(
          'components.agentSessionContinuation.metaWithAgent',
          'From {{agent}} · {{session}} · original stays unchanged',
          { agent: sourceAgentLabel, session }
        )
      : t('components.agentSessionContinuation.meta', '{{session}} · original stays unchanged', {
          session
        })
  return (
    <DialogHeader>
      <DialogTitle>
        {t('components.agentSessionContinuation.dialogTitleSentence', 'Hand off to another agent')}
      </DialogTitle>
      <DialogDescription size="compact">{description}</DialogDescription>
    </DialogHeader>
  )
}
