import { useEffect, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Loader2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { openAgentSettingsAction } from '@/components/settings/navigation/open-agent-settings'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { AgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { formatAgentProductName } from '../../../../shared/agent-status/presentation/agent-type-label'
import { AgentHookConsentSlide, agentHookConsentSlides } from './AgentHookConsentSlides'
import {
  closeAgentHookConsentOffer,
  setAnsweringOnCard,
  startAgentHookConsentWatch,
  useAgentHookConsentOffer,
  type AgentHookConsentCardOffer
} from './agent-hook-consent-queue'
import { notifyAgentHookStatusesChanged } from './agent-hook-status-events'

const SLIDE_ADVANCE_MS = 5000
const SPINNER_DELAY_MS = 200
const SUCCESS_CLOSE_MS = 4000

type View =
  | { kind: 'ask' }
  | { kind: 'installing' }
  | { kind: 'done'; agents: AgentHookTarget[]; waiting: boolean }
  | { kind: 'failed'; detail: string }

/** Asks, the first time an agent runs in Orca, to install the hooks that make Orca's view of it complete. */
export function AgentHookConsentCard(): React.JSX.Element | null {
  const offer = useAgentHookConsentOffer()
  useEffect(() => {
    // Why: a paired browser's agents run on the host, whose own desktop asks.
    if (isPairedWebClientWindow()) {
      return
    }
    return startAgentHookConsentWatch()
  }, [])
  return offer ? <AgentHookConsentOfferCard key={offer.agent} offer={offer} /> : null
}

function agentNames(agents: readonly AgentHookTarget[]): string {
  return agents.map((agent) => formatAgentProductName(agent)).join(', ')
}

function WhatHooksDo({
  agent,
  configPath,
  t
}: {
  agent: AgentHookTarget
  configPath: string
  t: Translate
}): React.JSX.Element {
  const name = formatAgentProductName(agent)
  const lines = [
    t(
      'agentHookConsent.safe.onlyOrca',
      'Only active in Orca. {{agent}} outside Orca works exactly as before.',
      {
        agent: name
      }
    ),
    t('agentHookConsent.safe.free', 'Free: no tokens or usage.'),
    t('agentHookConsent.safe.asks', '{{agent}} still asks you before acting, just like today.', {
      agent: name
    }),
    t('agentHookConsent.safe.turnOff', 'Turn off anytime in Settings › Agents.')
  ]
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-xs"
          aria-label={t('agentHookConsent.whatHooksDo', 'What hooks do')}
        >
          <CircleHelp />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start">
        <div className="w-64 text-xs leading-relaxed">
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line} className="grid grid-cols-[14px_1fr] gap-1.5">
                <Check className="mt-0.5 size-3 text-status-success" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {configPath ? (
            <p className="mt-2 text-muted-foreground">
              {t('agentHookConsent.safe.writes', 'Adds Orca’s hooks to')}{' '}
              <span className="font-mono break-all">{configPath}</span>
            </p>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

function AgentHookConsentOfferCard({
  offer
}: {
  offer: AgentHookConsentCardOffer
}): React.JSX.Element {
  const t = useTranslate()
  const name = formatAgentProductName(offer.agent)
  const slides = agentHookConsentSlides(offer.agent)
  const [slide, setSlide] = useState(0)
  const [paused, setPaused] = useState(false)
  const [all, setAll] = useState(true)
  const [view, setView] = useState<View>({ kind: 'ask' })
  const [showSpinner, setShowSpinner] = useState(false)
  const [declining, setDeclining] = useState(false)
  const busy = view.kind === 'installing' || declining

  useEffect(() => {
    if (
      view.kind !== 'ask' ||
      paused ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    // Advancing is the carousel itself; it pauses while hidden, hovered or answered.
    return installWindowVisibilityInterval({
      run: () => setSlide((index) => (index + 1) % slides.length),
      runOnVisible: () => {},
      intervalMs: SLIDE_ADVANCE_MS
    })
  }, [view.kind, paused, slides.length])

  useEffect(() => {
    if (view.kind !== 'installing') {
      setShowSpinner(false)
      return
    }
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [view.kind])

  useEffect(() => {
    if (view.kind !== 'done') {
      return
    }
    const timer = setTimeout(() => closeAgentHookConsentOffer({ later: false }), SUCCESS_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [view.kind])

  const coversAll = all && offer.agents.length > 1
  const install = async (): Promise<void> => {
    const agents = coversAll ? offer.agents : [offer.agent]
    setView({ kind: 'installing' })
    setAnsweringOnCard(true)
    try {
      const statuses = await window.api.agentHookConsent.decide({ agents, decision: 'granted' })
      notifyAgentHookStatusesChanged()
      const failed = statuses.find((status) => status.state === 'error')
      // Skipped means approved but nothing written yet (CLI not found on this side, e.g. only in WSL).
      const waiting = statuses.some(
        (status) => status.agent === offer.agent && status.state === 'skipped'
      )
      setView(
        failed
          ? { kind: 'failed', detail: failed.detail ?? failed.configPath }
          : { kind: 'done', agents, waiting }
      )
    } catch (error) {
      setView({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const neverAsk = async (): Promise<void> => {
    // Commit the decline before the next offer is built, and keep the card if it fails.
    setDeclining(true)
    setAnsweringOnCard(true)
    try {
      await window.api.agentHookConsent.decide({ agents: [offer.agent], decision: 'declined' })
      notifyAgentHookStatusesChanged()
    } catch (error) {
      setAnsweringOnCard(false)
      setDeclining(false)
      toast.error(t('agentHookConsent.declineFailed', 'Couldn’t save your choice'), {
        description: error instanceof Error ? error.message : String(error)
      })
      return
    }
    closeAgentHookConsentOffer({ later: false })
    toast(
      t('agentHookConsent.declined.title', 'Didn’t install hooks for {{agent}}', { agent: name }),
      {
        description: t(
          'agentHookConsent.declined.description',
          'Install them anytime in Settings › Agents.'
        ),
        action: openAgentSettingsAction(undefined, t)
      }
    )
  }

  const later = (): void => closeAgentHookConsentOffer({ later: true })
  const closeButton = (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon-xs"
      disabled={busy}
      onClick={view.kind === 'done' ? () => closeAgentHookConsentOffer({ later: false }) : later}
      aria-label={t('agentHookConsent.close', 'Close')}
    >
      <X />
    </Button>
  )

  if (view.kind === 'done' || view.kind === 'failed') {
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
                      agent: name
                    })}
            </p>
            {closeButton}
          </div>
          <p className="pr-2 pl-9 text-xs text-muted-foreground">
            {done && view.waiting
              ? t(
                  'agentHookConsent.approvedNext',
                  'Orca adds them once it finds {{agent}} on this computer.',
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
              <Button type="button" variant="ghost" size="sm" onClick={later}>
                {t('agentHookConsent.later', 'Later')}
              </Button>
              <Button type="button" size="sm" onClick={() => void install()}>
                {t('agentHookConsent.retry', 'Try again')}
              </Button>
            </div>
          )}
        </div>
      </Card>
    )
  }

  return (
    <Card
      size="notice"
      role="complementary"
      aria-label={t('agentHookConsent.title', 'Install hooks for {{agent}}?', { agent: name })}
      className="overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          const step = event.key === 'ArrowRight' ? 1 : -1
          setSlide((index) => (index + step + slides.length) % slides.length)
        }
      }}
    >
      <div className="p-2">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            <AgentTypeIcon agentType={offer.agent} size={16} />
          </span>
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {t('agentHookConsent.title', 'Install hooks for {{agent}}?', { agent: name })}
          </p>
          <WhatHooksDo agent={offer.agent} configPath={offer.configPath} t={t} />
          {closeButton}
        </div>
        <div className="mx-2 mt-2 overflow-hidden rounded-lg bg-(--notice-secondary)">
          <div
            className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(-${slide * 100}%)` }}
          >
            {slides.map((id, index) => (
              <div key={id} className="h-[200px] w-full shrink-0" aria-hidden={index !== slide}>
                <AgentHookConsentSlide id={id} agent={offer.agent} t={t} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-center gap-2 pt-1.5">
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label={t('agentHookConsent.previous', 'Previous')}
            onClick={() => setSlide((index) => (index - 1 + slides.length) % slides.length)}
          >
            <ChevronLeft />
          </Button>
          <div className="flex items-center gap-1.5">
            {slides.map((id, index) => (
              <button
                key={id}
                type="button"
                aria-label={t('agentHookConsent.slideN', 'Slide {{n}}', { n: index + 1 })}
                aria-current={index === slide}
                onClick={() => setSlide(index)}
                className={cn(
                  'h-1.5 cursor-pointer rounded-full transition-[width,background-color]',
                  index === slide ? 'w-3.5 bg-popover-foreground' : 'w-1.5 bg-popover-foreground/25'
                )}
              />
            ))}
          </div>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label={t('agentHookConsent.next', 'Next')}
            onClick={() => setSlide((index) => (index + 1) % slides.length)}
          >
            <ChevronRight />
          </Button>
        </div>
        {offer.agents.length > 1 ? (
          <label className="flex cursor-pointer items-start gap-2 px-2 pt-2">
            <Checkbox
              className="mt-0.5"
              checked={all}
              disabled={busy}
              onCheckedChange={(checked) => setAll(checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-[13px] leading-[18px]">
                {t('agentHookConsent.allAgents', 'Install for all my agents')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {agentNames(offer.agents)}
              </span>
            </span>
          </label>
        ) : null}
        <div className="flex items-center gap-1 px-2 pt-2">
          <Button
            type="button"
            variant="ghost-muted"
            size="xs"
            className="-ml-2"
            disabled={busy}
            onClick={() => void neverAsk()}
          >
            {t('agentHookConsent.dontAsk', 'Don’t ask again')}
          </Button>
          <span className="ml-auto" />
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={later}>
            {t('agentHookConsent.later', 'Later')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="w-20"
            disabled={busy}
            onClick={() => void install()}
          >
            {view.kind === 'installing' && showSpinner ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              t('agentHookConsent.install', 'Install')
            )}
          </Button>
        </div>
      </div>
    </Card>
  )
}
