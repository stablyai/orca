import { Check, Download } from 'lucide-react'
import { useManagedRuntimeInstallCard } from '@/components/managed-runtime/use-managed-runtime-install-card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatInstallSlotInstall } from './NativeChatInstallSlot'
import { NativeChatInstallTile } from './NativeChatInstallTile'

/** A new chat's pane while its host has no program to run: what Install is, one action, and the
 *  steps once it runs. The composer stays below, disabled, so nothing moves when it finishes. */
export function NativeChatInstallHero(props: {
  slot: NativeChatInstallSlotInstall
  agentLabel: string
}): React.JSX.Element {
  const { slot, agentLabel } = props
  const { card, pending, refusal, act } = useManagedRuntimeInstallCard(
    slot.observation,
    slot.state,
    agentLabel,
    'hero'
  )
  const { action, progress, steps } = card
  return (
    <div
      data-native-chat-install="hero"
      className="flex h-full w-full flex-col items-center justify-center p-6 text-center"
    >
      <div className="flex w-full max-w-sm flex-col items-center">
        <NativeChatInstallTile
          agent={slot.observation.subject.agent}
          failed={card.tone === 'failed'}
          large
        />
        <h2 className="mt-4 text-sm font-semibold text-chat-foreground-strong">{card.title}</h2>
        {card.detail ? (
          <p className="mt-1.5 text-balance text-sm text-chat-foreground-faint">{card.detail}</p>
        ) : null}
        {progress ? (
          <div className="mt-3 w-full">
            <Progress
              value={progress.percent ?? 100}
              className="h-1.5"
              aria-label={translate('components.managed-runtime.progress', '{{agent}} download', {
                agent: agentLabel
              })}
            />
            <div
              role="status"
              aria-live="polite"
              className="mt-2 flex justify-between text-xs text-chat-foreground-faint tabular-nums"
            >
              <span>{progress.detail}</span>
              <span>{progress.percentText}</span>
            </div>
          </div>
        ) : null}
        {steps ? (
          <ol className="mt-3 mb-3 flex justify-center gap-4 text-xs">
            {steps.map((step) => (
              <li
                key={step.label}
                aria-current={step.state === 'current' ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5',
                  step.state === 'current'
                    ? 'font-medium text-chat-foreground-strong'
                    : 'text-chat-foreground-faint'
                )}
              >
                {step.state === 'done' ? (
                  <Check className="size-3" />
                ) : (
                  <span
                    className={cn(
                      'size-1.5 rounded-full bg-current',
                      step.state === 'current' ? 'opacity-100' : 'opacity-40'
                    )}
                  />
                )}
                {step.label}
              </li>
            ))}
          </ol>
        ) : null}
        {action ? (
          <Button
            variant={action.kind === 'cancel' ? 'ghost' : 'default'}
            className={action.kind === 'cancel' ? 'mt-1' : 'mt-5'}
            disabled={pending}
            onClick={() => act(action)}
          >
            {action.kind === 'install' ? <Download /> : null}
            {action.label}
          </Button>
        ) : null}
        {card.hint ? <p className="mt-3 text-xs text-chat-foreground-faint">{card.hint}</p> : null}
        {refusal ? (
          <p role="alert" className="mt-3 break-words text-xs text-destructive">
            {refusal}
          </p>
        ) : null}
      </div>
    </div>
  )
}
