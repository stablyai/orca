import { Download } from 'lucide-react'
import { useManagedRuntimeInstallCard } from '@/components/managed-runtime/use-managed-runtime-install-card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { NativeChatInstallTile } from './NativeChatInstallTile'
import type { NativeChatInstallSlotInstall } from './NativeChatInstallSlot'

/** The same install card, slimmed to one line above the composer for a chat that has messages. */
export function NativeChatInstallStrip(props: {
  slot: NativeChatInstallSlotInstall
  agentLabel: string
}): React.JSX.Element {
  const { slot, agentLabel } = props
  const { card, pending, refusal, act } = useManagedRuntimeInstallCard(
    slot.observation,
    slot.state,
    agentLabel,
    'strip'
  )
  const { action, progress } = card
  const status = progress
    ? [progress.detail, progress.percentText].filter(Boolean).join(' · ')
    : card.detail
  return (
    <div
      data-native-chat-install="strip"
      className="flex items-center gap-3 rounded-xl border border-input bg-card px-3.5 py-3 text-sm shadow-xs"
    >
      <NativeChatInstallTile
        agent={slot.observation.subject.agent}
        failed={card.tone === 'failed'}
        large={false}
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground">{card.title}</p>
        {status ? (
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground tabular-nums"
          >
            {status}
          </p>
        ) : null}
        {progress ? (
          <Progress
            value={progress.percent ?? 100}
            className="mt-2 h-1.5"
            aria-label={translate('components.managed-runtime.progress', '{{agent}} download', {
              agent: agentLabel
            })}
          />
        ) : null}
        {refusal ? (
          <p role="alert" className="mt-1 break-words text-xs text-destructive">
            {refusal}
          </p>
        ) : null}
      </div>
      {action ? (
        <Button
          size="sm"
          variant={action.kind === 'cancel' ? 'ghost' : 'default'}
          disabled={pending}
          onClick={() => act(action)}
        >
          {action.kind === 'install' && card.tone === 'offer' ? <Download /> : null}
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
