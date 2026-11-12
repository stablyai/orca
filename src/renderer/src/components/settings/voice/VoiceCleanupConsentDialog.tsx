import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'

// Only agents whose service is fixed; the others go wherever the user set them up to send.
const AGENT_SERVICES: Record<string, { company: string; plan: string }> = {
  claude: { company: 'Anthropic', plan: 'Claude' },
  codex: { company: 'OpenAI', plan: 'ChatGPT' }
}

function destination(agentId: string, agentLabel: string, t: Translate): string {
  const service = AGENT_SERVICES[agentId]
  return service
    ? t(
        'components.settings.voice.cleanup.consent.goesToKnown',
        '{{company}}, through {{agent}} on this computer. Counts toward your {{plan}} plan.',
        { ...service, agent: agentLabel }
      )
    : t(
        'components.settings.voice.cleanup.consent.goesToAgent',
        'Wherever {{agent}} on this computer is set up to send prompts.',
        { agent: agentLabel }
      )
}

/** Asked before dictated text first goes to an agent, and again for each new agent. */
export function VoiceCleanupConsentDialog({
  request,
  onCancel,
  onConfirm
}: {
  /** The agent text would go to; null keeps the dialog closed. */
  request: { agentId: string; agentLabel: string } | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const agentLabel = request?.agentLabel ?? ''
  const rows = request
    ? [
        {
          label: t('components.settings.voice.cleanup.consent.sentLabel', 'Sent'),
          value: t(
            'components.settings.voice.cleanup.consent.sent',
            'The dictated text, your vocabulary and your instructions.'
          )
        },
        {
          label: t('components.settings.voice.cleanup.consent.notSentLabel', 'Not sent'),
          value: t(
            'components.settings.voice.cleanup.consent.notSent',
            'Audio, files, or what’s on screen.'
          )
        },
        {
          label: t('components.settings.voice.cleanup.consent.goesToLabel', 'Goes to'),
          value: destination(request.agentId, agentLabel, t)
        },
        {
          label: t('components.settings.voice.cleanup.consent.waitLabel', 'Wait'),
          value: t(
            'components.settings.voice.cleanup.consent.wait',
            'Text lands a few seconds later.'
          )
        }
      ]
    : []
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent surface="security" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('components.settings.voice.cleanup.consent.title', 'Turn on AI cleanup?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.settings.voice.cleanup.consent.description',
              'After each dictation, Orca sends the text to {{agent}} to tidy it before it lands.',
              { agent: agentLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('components.settings.voice.cleanup.consent.cancel', 'Cancel')}
          </Button>
          <Button onClick={onConfirm}>
            {t('components.settings.voice.cleanup.consent.confirm', 'Turn on')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
