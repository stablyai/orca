import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight, Eye } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { nativeChatToolRowVerb } from '@/components/native-chat/tools/lines/native-chat-tool-line-label'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  CHAT_DEMO_FILE,
  CHAT_DEMO_FINISHED_AT,
  CHAT_DEMO_LOOP_MS,
  createChatDemoTimeline,
  getChatDemoCopy,
  type ChatDemoCopy,
  type ChatDemoFrame
} from './chat-ui-here-feature-tip-demo'
import {
  FeatureTipChatCard,
  FeatureTipChatComposer,
  FeatureTipChatUserBubble
} from './FeatureTipChatCard'

/** A row that takes no height until it appears, so the transcript grows from its end. */
export function FeatureTipRevealRow({
  on,
  children
}: {
  on: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div
      data-on={on}
      className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-out data-[on=true]:grid-rows-[1fr] data-[on=true]:opacity-100"
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** Boxes size to their labels; the arrows share what is left of the row. Also drawn still in Settings. */
export function FlowDiagram({
  flow,
  frame
}: {
  flow: ChatDemoCopy['flow']
  frame: Pick<ChatDemoFrame, 'nodes' | 'arrows'>
}): JSX.Element {
  return (
    <div className="flex items-end pt-[5px] pb-[10px]">
      {flow.map((node, index) => (
        <div key={node.name} className="contents">
          <span
            data-on={index < frame.nodes}
            className="flex h-[30px] shrink-0 scale-[0.94] items-center rounded-[7px] border border-[color:color-mix(in_srgb,var(--chart-3)_55%,transparent)] bg-[color-mix(in_srgb,var(--chart-1)_16%,var(--chat-canvas))] px-[9px] text-[10.5px] font-medium whitespace-nowrap text-chat-foreground-strong opacity-0 transition-[opacity,scale] duration-300 ease-out data-[on=true]:scale-100 data-[on=true]:opacity-100"
          >
            {node.name}
          </span>
          {node.arrow !== null ? (
            <span
              data-on={index < frame.arrows}
              className="group/arrow flex min-w-[20px] flex-1 flex-col items-center gap-[4px] px-[4px]"
            >
              {/* Centred over the arrow without widening it, so long labels never push the boxes out. */}
              <span className="relative h-[12px] w-full">
                <span className="absolute left-1/2 -translate-x-1/2 text-[9px] leading-[12px] whitespace-nowrap text-chat-foreground-faint opacity-0 transition-opacity delay-100 duration-300 group-data-[on=true]/arrow:opacity-100">
                  {node.arrow}
                </span>
              </span>
              <span className="flex h-[30px] w-full items-center">
                <span className="h-[1.25px] flex-1 origin-left scale-x-0 bg-chart-3 transition-[scale] duration-300 ease-in-out group-data-[on=true]/arrow:scale-x-100" />
                <svg
                  viewBox="0 0 4 6"
                  fill="none"
                  className="-ml-px h-1.5 w-1 stroke-chart-3 opacity-0 transition-opacity delay-250 duration-100 [stroke-width:1.25] group-data-[on=true]/arrow:opacity-100"
                >
                  <path d="M0 0 L4 3 L0 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function Transcript({ copy, frame }: { copy: ChatDemoCopy; frame: ChatDemoFrame }): JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="flex min-h-full shrink-0 flex-col transition-opacity duration-700 ease-in-out"
      style={{ opacity: frame.faded ? 0 : 1 }}
    >
      {/* The sent message rises out of the composer at full height, so only its position moves. */}
      <div
        data-on={frame.sent}
        className="grid grid-rows-[0fr] translate-y-[150px] opacity-0 transition-[opacity,translate] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] data-[on=true]:grid-rows-[1fr] data-[on=true]:translate-y-0 data-[on=true]:opacity-100"
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-4">
            <FeatureTipChatUserBubble>{copy.prompt}</FeatureTipChatUserBubble>
          </div>
        </div>
      </div>
      <FeatureTipRevealRow on={frame.tool}>
        <div className="mt-5 flex min-h-6.5 items-center gap-2 whitespace-nowrap">
          <span className="flex size-4 items-center justify-center text-chat-foreground-faint">
            <Eye className="size-3.5" />
          </span>
          <span className="text-chat-foreground-faint">{nativeChatToolRowVerb('read', t)}</span>
          <span>{CHAT_DEMO_FILE}</span>
          <ChevronRight className="ml-auto size-3.5 text-chat-foreground-faint" />
        </div>
      </FeatureTipRevealRow>
      <FeatureTipRevealRow on={frame.working}>
        <div className="mt-3 flex min-h-6 items-center gap-1.5 text-chat-foreground-faint">
          <LoadingSpinner className="size-4 shrink-0" />
          <span className="text-chat-foreground">
            {t('components.native-chat.status.working', 'Working…')}
          </span>
        </div>
      </FeatureTipRevealRow>
      <FeatureTipRevealRow on={frame.words > 0}>
        <p className="mt-3">
          {copy.reply.map((token, index) => (
            <span
              key={index}
              data-on={index < frame.words}
              className={cn(
                'opacity-0 transition-opacity duration-100 data-[on=true]:opacity-100',
                token.link &&
                  'text-chat-foreground-strong underline decoration-current/40 underline-offset-2'
              )}
            >
              {token.text}
            </span>
          ))}
        </p>
      </FeatureTipRevealRow>
      <FeatureTipRevealRow on={frame.visual}>
        <div className="relative mt-1 mb-0.5">
          <div
            data-on={!frame.page}
            className="absolute inset-0 rounded-md bg-muted/30 opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100"
          />
          <div
            data-on={frame.page}
            className="relative opacity-0 transition-opacity duration-300 data-[on=true]:opacity-100"
          >
            <FlowDiagram flow={copy.flow} frame={frame} />
          </div>
        </div>
      </FeatureTipRevealRow>
    </div>
  )
}

/** The animated chat miniature used by the tip dialog. */
export function ChatUiDemoCard({
  loop = true,
  className
}: {
  /** A one-shot demo holds its finished frame; the dialog loops it. */
  loop?: boolean
  className?: string
}): JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const reducedMotion = usePrefersReducedMotion()
  const copy = getChatDemoCopy(t, intlLocale)
  const promptLength = Array.from(copy.prompt).length
  const timeline = useMemo(
    () => createChatDemoTimeline(promptLength, copy.reply.length),
    [promptLength, copy.reply.length]
  )
  const [at, setAt] = useState(0)
  const frame = timeline.frameAt(reducedMotion ? CHAT_DEMO_FINISHED_AT : at)
  const finished = !loop && at >= CHAT_DEMO_FINISHED_AT

  useEffect(() => {
    if (reducedMotion || finished) {
      return
    }
    const next = timeline.nextBeat(at)
    const timeoutId = window.setTimeout(
      () => setAt(next >= CHAT_DEMO_LOOP_MS ? 0 : next),
      next - at
    )
    return () => window.clearTimeout(timeoutId)
  }, [at, finished, reducedMotion, timeline])

  return (
    <FeatureTipChatCard
      tabTitle={copy.tabTitle}
      className={className}
      footer={
        <FeatureTipChatComposer
          send={frame.send}
          draft={
            frame.typed > 0 ? (
              <span className="whitespace-pre text-chat-foreground-strong">
                {Array.from(copy.prompt).slice(0, frame.typed).join('')}
                <span className="ml-px inline-block h-[14px] w-px bg-chat-foreground-strong align-[-3px]" />
              </span>
            ) : null
          }
        />
      }
    >
      <Transcript copy={copy} frame={frame} />
    </FeatureTipChatCard>
  )
}

/** A miniature chat that sends one question and draws its reply, then fades and starts over. */
export function ChatUiHereFeatureTipVisual(): JSX.Element {
  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      {/* Turning reduced motion on mid-loop jumps straight to the finished still. */}
      <ChatUiDemoCard />
    </div>
  )
}
