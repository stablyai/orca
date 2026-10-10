import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { useAgentBucketCounts } from '../dashboard/useAgentBucketCounts'
import { translate } from '@/i18n/i18n'
import {
  PET_SPEECH_VISIBLE_MS,
  petSpeechForCountChange,
  petSpeechReminderMs,
  petSpeechText,
  type PetSpeech,
  type PetSpeechKind
} from './pet-speech-bubble'
import type { Position } from './PetOverlay'

// Why: above the pet unless that would clip the top edge.
const BUBBLE_FLIP_THRESHOLD_PX = 64

function usePetSpeech(
  enabled: boolean,
  reminderMs: number | null
): {
  speech: PetSpeech | null
  dismiss: () => void
} {
  const counts = useAgentBucketCounts()
  const pending = counts.attention + counts.done
  const prevRef = useRef(counts)
  const pendingRef = useRef(pending)
  const nextIdRef = useRef(0)
  const [speech, setSpeech] = useState<PetSpeech | null>(null)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = counts
    pendingRef.current = counts.attention + counts.done
    const kind = enabled ? petSpeechForCountChange(prev, counts) : null
    if (kind) {
      setSpeech({
        kind,
        count: kind === 'waiting' ? counts.attention : counts.done,
        id: ++nextIdRef.current
      })
    }
  }, [counts, enabled])

  const hasPending = pending > 0
  useEffect(() => {
    if (!enabled || !hasPending || reminderMs === null) {
      return
    }
    const timer = setInterval(() => {
      setSpeech({ kind: 'reminder', count: pendingRef.current, id: ++nextIdRef.current })
    }, reminderMs)
    return () => clearInterval(timer)
  }, [enabled, hasPending, reminderMs])

  const speechId = speech?.id
  useEffect(() => {
    if (speechId === undefined) {
      return
    }
    const timer = setTimeout(() => setSpeech(null), PET_SPEECH_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [speechId])

  return { speech: enabled ? speech : null, dismiss: () => setSpeech(null) }
}

export function defaultSpeechText(kind: PetSpeechKind): string {
  switch (kind) {
    case 'done':
      return translate(
        'auto.components.pet.PetSpeechBubble.doneDefault',
        'All done! Come take a look.'
      )
    case 'waiting':
      return translate(
        'auto.components.pet.PetSpeechBubble.waitingDefault',
        'An agent needs your input.'
      )
    case 'reminder':
      return translate(
        'auto.components.pet.PetSpeechBubble.reminderDefault',
        '{count} agent(s) still waiting for you.'
      )
  }
}

export function PetSpeechBubble({
  position,
  size
}: {
  position: Position
  size: number
}): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.petSpeechBubbles !== false)
  const doneText = useAppStore((s) => s.settings?.petSpeechDoneText)
  const waitingText = useAppStore((s) => s.settings?.petSpeechWaitingText)
  const reminderText = useAppStore((s) => s.settings?.petSpeechReminderText)
  const reminderMinutes = useAppStore((s) => s.settings?.petSpeechReminderMinutes)
  const { speech, dismiss } = usePetSpeech(enabled, petSpeechReminderMs(reminderMinutes))

  if (!speech) {
    return null
  }
  const template = { done: doneText, waiting: waitingText, reminder: reminderText }[speech.kind]
  const text = petSpeechText(template, defaultSpeechText(speech.kind), speech.count)
  const below = position.y < BUBBLE_FLIP_THRESHOLD_PX

  return (
    <div
      className="pointer-events-none fixed z-40 flex justify-end"
      style={{
        left: position.x,
        top: below ? position.y + size : position.y,
        width: size,
        transform: below ? undefined : 'translateY(-100%)'
      }}
    >
      <button
        type="button"
        role="status"
        aria-live="polite"
        onClick={dismiss}
        className="pointer-events-auto max-w-[240px] cursor-pointer rounded-md border border-border bg-popover px-2.5 py-1.5 text-left text-xs text-popover-foreground shadow-floating"
      >
        {text}
      </button>
    </div>
  )
}
