import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

/** full: "Send 3 notes", short: "Send 3", icon: send icon + count. */
export type SendNotesTier = 'full' | 'short' | 'icon'
export type SendNotesNoun = 'notes' | 'comments'
/** md is 28px; sm (24px) is only for rows shorter than 36px. */
export type SendNotesButtonSize = 'md' | 'sm'

type SendNotesFace = {
  count: number
  noun: SendNotesNoun
  size: SendNotesButtonSize
  sending: boolean
  chevron: boolean
}

const TIERS: readonly SendNotesTier[] = ['full', 'short', 'icon']

function buttonSize(size: SendNotesButtonSize): 'send-notes' | 'send-notes-sm' {
  return size === 'sm' ? 'send-notes-sm' : 'send-notes'
}

export function sendNotesAccessibleName(t: Translate, count: number, noun: SendNotesNoun): string {
  return noun === 'comments'
    ? t('components.notes.sendButton.sendCommentsToAgent', 'Send {{count}} comments to an agent', {
        count,
        defaultValue_one: 'Send {{count}} comment to an agent'
      })
    : t('components.notes.sendButton.sendNotesToAgent', 'Send {{count}} notes to an agent', {
        count,
        defaultValue_one: 'Send {{count}} note to an agent'
      })
}

function faceLabel(t: Translate, face: SendNotesFace, tier: SendNotesTier): string | null {
  if (face.sending) {
    return tier === 'icon' ? null : t('components.notes.sendButton.sending', 'Sending…')
  }
  if (tier === 'icon') {
    return String(face.count)
  }
  if (tier === 'short') {
    return t('components.notes.sendButton.sendShort', 'Send {{count}}', { count: face.count })
  }
  return face.noun === 'comments'
    ? t('components.notes.sendButton.sendComments', 'Send {{count}} comments', {
        count: face.count,
        defaultValue_one: 'Send {{count}} comment'
      })
    : t('components.notes.sendButton.sendNotes', 'Send {{count}} notes', {
        count: face.count,
        defaultValue_one: 'Send {{count}} note'
      })
}

function SendNotesFaceContent({
  face,
  tier
}: {
  face: SendNotesFace
  tier: SendNotesTier
}): React.JSX.Element {
  const t = useTranslate()
  const label = faceLabel(t, face, tier)
  return (
    <>
      {face.sending ? <LoadingSpinner className="size-3.5" /> : <Send className="size-3.5" />}
      {label !== null ? <span className="whitespace-nowrap tabular-nums">{label}</span> : null}
      {face.chevron && !face.sending && tier !== 'icon' ? (
        <ChevronDown className="size-3 opacity-60" />
      ) : null}
    </>
  )
}

type SendNotesSlotValue = {
  tier: SendNotesTier
  setFace: (face: SendNotesFace | null) => void
}

const SendNotesSlotContext = createContext<SendNotesSlotValue | null>(null)

/**
 * The space right after a title that a send button may use. It fills the row (so the
 * controls after it stay put) and picks the widest label that fits that space.
 */
export function SendNotesSlot({
  className,
  fitContent = false,
  children
}: {
  className?: string
  fitContent?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const slotRef = useRef<HTMLSpanElement>(null)
  const sizerRef = useRef<HTMLSpanElement>(null)
  const [face, setFace] = useState<SendNotesFace | null>(null)
  const [fit, setFit] = useState<{ tier: SendNotesTier; minWidth: number; fullWidth: number }>({
    tier: 'full',
    minWidth: 0,
    fullWidth: 0
  })

  useLayoutEffect(() => {
    const slot = slotRef.current
    const sizer = sizerRef.current
    if (!face || !slot || !sizer) {
      return
    }
    const measure = (): void => {
      const [full, short, icon] = Array.from(
        sizer.children,
        (el) => el.getBoundingClientRect().width
      )
      const available = slot.getBoundingClientRect().width
      const tier: SendNotesTier = available >= full ? 'full' : available >= short ? 'short' : 'icon'
      const minWidth = Math.ceil(icon)
      const fullWidth = Math.ceil(full)
      setFit((prev) =>
        prev.tier === tier && prev.minWidth === minWidth && prev.fullWidth === fullWidth
          ? prev
          : { tier, minWidth, fullWidth }
      )
    }
    measure()
    // Each label is watched on its own: a font or language change can resize a narrower one alone.
    const observer = new ResizeObserver(measure)
    observer.observe(slot)
    for (const tierLabel of sizer.children) {
      observer.observe(tierLabel)
    }
    return () => observer.disconnect()
  }, [face])

  const value = useMemo(() => ({ tier: fit.tier, setFace }), [fit.tier])

  return (
    <span
      ref={slotRef}
      data-send-notes-slot=""
      className={cn('relative flex min-w-0 flex-1 items-center', className)}
      // A zero flex basis gives the preceding text its natural width until only the icon fits.
      style={
        face ? { minWidth: fit.minWidth, width: fitContent ? fit.fullWidth : undefined } : undefined
      }
    >
      <SendNotesSlotContext.Provider value={value}>{children}</SendNotesSlotContext.Provider>
      {face ? (
        <span
          aria-hidden
          inert
          className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden"
        >
          <span ref={sizerRef} className="flex w-max flex-col items-start">
            {TIERS.map((tier) => (
              <span
                key={tier}
                className={buttonVariants({ variant: 'default', size: buttonSize(face.size) })}
              >
                <SendNotesFaceContent face={face} tier={tier} />
              </span>
            ))}
          </span>
        </span>
      ) : null}
    </span>
  )
}

export type SendNotesButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  'children' | 'size' | 'variant'
> & {
  count: number
  noun?: SendNotesNoun
  size?: SendNotesButtonSize
  /** Forces a label; otherwise the enclosing SendNotesSlot picks one, or the full label. */
  tier?: SendNotesTier
  sending?: boolean
  /** Off when the click opens no menu. */
  chevron?: boolean
  /** In a row sized by 24px controls, lay out as 24px so the row keeps its height. */
  flush?: boolean
}

export const SendNotesButton = React.forwardRef<HTMLButtonElement, SendNotesButtonProps>(
  function SendNotesButton(
    {
      count,
      noun = 'notes',
      size = 'md',
      tier: tierProp,
      sending = false,
      chevron = true,
      flush = false,
      disabled,
      ...props
    },
    ref
  ) {
    const t = useTranslate()
    const slot = useContext(SendNotesSlotContext)
    const setSlotFace = slot?.setFace
    useLayoutEffect(() => {
      if (!setSlotFace) {
        return
      }
      setSlotFace({ count, noun, size, sending, chevron })
      return () => setSlotFace(null)
    }, [setSlotFace, count, noun, size, sending, chevron])

    const tier = tierProp ?? slot?.tier ?? 'full'
    const name = sendNotesAccessibleName(t, count, noun)
    const isDisabled = Boolean(disabled) || sending
    const button = (
      <Button
        ref={ref}
        type="button"
        variant="default"
        size={buttonSize(size)}
        className={flush ? '-my-0.5' : undefined}
        disabled={isDisabled}
        aria-label={sending ? t('components.notes.sendButton.sending', 'Sending…') : name}
        {...props}
      >
        <SendNotesFaceContent face={{ count, noun, size, sending, chevron }} tier={tier} />
      </Button>
    )
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        {!sending ? (
          <TooltipContent side="bottom" sideOffset={6}>
            {name}
          </TooltipContent>
        ) : null}
      </Tooltip>
    )
  }
)
