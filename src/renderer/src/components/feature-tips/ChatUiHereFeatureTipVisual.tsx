import { useEffect, useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, ChevronRight, Eye, Hand, Plus, Square, X } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { nativeChatPermissionModeLabel } from '@/components/native-chat/native-chat-permission-mode-labels'
import { nativeChatToolRowVerb } from '@/components/native-chat/native-chat-tool-line-label'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  CHAT_DEMO_FILE,
  CHAT_DEMO_FINISHED_AT,
  CHAT_DEMO_LOOP_MS,
  CHAT_DEMO_MODEL,
  createChatDemoTimeline,
  getChatDemoCopy,
  type ChatDemoCopy,
  type ChatDemoFrame
} from './chat-ui-here-feature-tip-demo'

// The smallest chat text size, so the real chat spacing fits the 22rem card the sibling visuals use.
const CHAT_SCALE: CSSProperties & { '--chat-font-size': string } = { '--chat-font-size': '12px' }

/** A row that takes no height until it appears, so the transcript grows from its end. */
function Row({ on, children }: { on: boolean; children: ReactNode }): JSX.Element {
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
          <div className="mt-4 flex flex-col items-end">
            <div className="max-w-[80%] rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-chat-foreground-strong">
              {copy.prompt}
            </div>
          </div>
        </div>
      </div>
      <Row on={frame.tool}>
        <div className="mt-5 flex min-h-6.5 items-center gap-2 whitespace-nowrap">
          <span className="flex size-4 items-center justify-center text-chat-foreground-faint">
            <Eye className="size-3.5" />
          </span>
          <span className="text-chat-foreground-faint">{nativeChatToolRowVerb('read')}</span>
          <span>{CHAT_DEMO_FILE}</span>
          <ChevronRight className="ml-auto size-3.5 text-chat-foreground-faint" />
        </div>
      </Row>
      <Row on={frame.working}>
        <div className="mt-3 flex min-h-6 items-center gap-1.5 text-chat-foreground-faint">
          <LoadingSpinner className="size-4 shrink-0" />
          <span className="text-chat-foreground">
            {translate('components.native-chat.status.working', 'Working…')}
          </span>
        </div>
      </Row>
      <Row on={frame.words > 0}>
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
      </Row>
      <Row on={frame.visual}>
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
      </Row>
    </div>
  )
}

function Composer({ prompt, frame }: { prompt: string; frame: ChatDemoFrame }): JSX.Element {
  const typing = frame.typed > 0
  return (
    <div className="shrink-0 px-3 pt-1.5 pb-3">
      <div className="rounded-lg border border-chat-composer-border bg-chat-composer-surface p-1 shadow-xs">
        <div className="relative min-h-8 overflow-hidden px-2 py-0.5 whitespace-nowrap">
          {typing ? (
            <span className="whitespace-pre text-chat-foreground-strong">
              {Array.from(prompt).slice(0, frame.typed).join('')}
              <span className="ml-px inline-block h-[14px] w-px bg-chat-foreground-strong align-[-3px]" />
            </span>
          ) : (
            <span className="text-chat-foreground-faint">
              {translate(
                'components.native-chat.composer.placeholder',
                'Ask anything, @ to mention files, / for commands'
              )}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-1.5 text-chat-foreground-faint">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="flex size-6.5 shrink-0 items-center justify-center">
              <Plus className="size-3.5" />
            </span>
            <span className="flex h-5.5 min-w-0 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap">
              <Hand className="size-3 shrink-0" />
              <span className="truncate">{nativeChatPermissionModeLabel('ask')}</span>
              <ChevronDown className="size-3 shrink-0" />
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="flex h-5.5 items-center gap-1 px-1.5 text-xs font-medium whitespace-nowrap text-chat-foreground">
              {CHAT_DEMO_MODEL}
              <ChevronDown className="size-3 text-chat-foreground-faint" />
            </span>
            <span className="relative size-6.5">
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-primary text-primary-foreground transition-[opacity,scale] duration-100',
                  frame.send === 'empty' && 'opacity-50',
                  frame.send === 'pressed' && 'scale-[0.88]',
                  frame.send === 'stop' && 'opacity-0'
                )}
              >
                <ArrowUp className="size-3.5" />
              </span>
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-opacity duration-100',
                  frame.send !== 'stop' && 'opacity-0'
                )}
              >
                <Square className="size-3 fill-current" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A miniature chat that sends one question and draws its reply, then fades and starts over. */
export function ChatUiHereFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const copy = getChatDemoCopy()
  const promptLength = Array.from(copy.prompt).length
  const timeline = useMemo(
    () => createChatDemoTimeline(promptLength, copy.reply.length),
    [promptLength, copy.reply.length]
  )
  const [at, setAt] = useState(0)
  const frame = timeline.frameAt(reducedMotion ? CHAT_DEMO_FINISHED_AT : at)

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const next = timeline.nextBeat(at)
    const timeoutId = window.setTimeout(
      () => setAt(next >= CHAT_DEMO_LOOP_MS ? 0 : next),
      next - at
    )
    return () => window.clearTimeout(timeoutId)
  }, [at, reducedMotion, timeline])

  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      {/* Turning reduced motion on mid-loop jumps straight to the finished still. */}
      <div className="flex h-[22rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-chat-canvas text-left tracking-[0.01em] shadow-xs motion-reduce:**:transition-none">
        <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-card">
          <span className="-mb-px flex max-w-[75%] items-center gap-1.5 border-r border-border bg-chat-canvas px-3 text-[11px] whitespace-nowrap text-foreground">
            <span className="shrink-0">
              <AgentIcon agent="claude" size={12} />
            </span>
            <span className="truncate">{copy.tabTitle}</span>
            <X className="ml-1 size-2.5 shrink-0 text-muted-foreground" />
          </span>
        </div>
        <div
          className="native-chat-appearance flex min-h-0 flex-1 flex-col text-sm leading-relaxed text-chat-foreground"
          style={CHAT_SCALE}
        >
          {/* Bottom-anchored, so a transcript taller than the card keeps its end in view. */}
          <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-[calc(var(--spacing)*3+5px)]">
            <Transcript copy={copy} frame={frame} />
          </div>
          <Composer prompt={copy.prompt} frame={frame} />
        </div>
      </div>
    </div>
  )
}
