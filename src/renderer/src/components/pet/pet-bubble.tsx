import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { useAppStore } from '../../store'
import {
  formatPetBubbleText,
  pickPetBubbleLine,
  selectPetBubbleWinner,
  type PetBubbleMood,
  type PetBubbleWinner
} from './pet-bubble-text'

// Why: how long a bubble stays up after firing, ported from hermes-agent's
// pet-bubble but adapted per the operator's brief — hermes's bubble is a
// continuous, rotating fixture in its pop-out overlay; Orca's pet lives
// in-window all the time; a permanent chat-bubble sitting next to the app
// content would be a fidget, not a signal. So Orca's bubble is
// transition-triggered: it appears when the winning mood/agent changes,
// holds for this long, then fades — same "did something just happen" read,
// without occupying screen real estate at rest.
const BUBBLE_HOLD_MS = 3000

// Short phrasings per mood, ported from hermes-agent's pet-bubble. Localized
// via translate() so every catalog gets the same word bank; picked at random
// (no immediate repeat) purely for a bit of life while a mood holds across
// re-renders (e.g. two panes independently entering `running`).
function moodLines(mood: PetBubbleMood): string[] {
  switch (mood) {
    case 'waiting':
      return [
        translate('auto.components.pet.pet-bubble.waiting1', 'waiting…'),
        translate('auto.components.pet.pet-bubble.waiting2', 'your turn'),
        translate('auto.components.pet.pet-bubble.waiting3', 'all yours')
      ]
    case 'failed':
      return [
        translate('auto.components.pet.pet-bubble.failed1', 'cancelled'),
        translate('auto.components.pet.pet-bubble.failed2', 'stopped'),
        translate('auto.components.pet.pet-bubble.failed3', 'interrupted')
      ]
    case 'waving':
      return [
        translate('auto.components.pet.pet-bubble.waving1', 'done!'),
        translate('auto.components.pet.pet-bubble.waving2', 'finished!'),
        translate('auto.components.pet.pet-bubble.waving3', 'all set!')
      ]
    case 'running':
      return [
        translate('auto.components.pet.pet-bubble.running1', 'working…'),
        translate('auto.components.pet.pet-bubble.running2', 'on it…'),
        translate('auto.components.pet.pet-bubble.running3', 'in progress…')
      ]
  }
}

function countSuffix(extra: number): string {
  return translate('auto.components.pet.pet-bubble.countSuffix', '+{{value0}}', { value0: extra })
}

function winnerKey(winner: PetBubbleWinner | null): string {
  if (!winner) {
    return ''
  }
  // Why: identity for "did the winner actually change" — mood + attributed
  // agent + count, so a re-render with the same winner doesn't restart the
  // hold timer or re-pick a line, but a genuinely new winner does.
  return `${winner.mood}:${winner.agentType ?? ''}:${winner.count}`
}

/** Live text for the pet speech bubble, or null when nothing should show
 *  (no fresh winner, or the hold window has elapsed). Pure aggregation lives
 *  in pet-bubble-text.ts; this hook only owns the show/hold/fade timing and
 *  the localized phrase bank. */
export function usePetBubbleText(): string | null {
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  void agentStatusEpoch

  const winner = selectPetBubbleWinner(
    Object.values(agentStatusByPaneKey),
    Date.now(),
    AGENT_STATUS_STALE_AFTER_MS
  )

  const [visible, setVisible] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const lastKeyRef = useRef('')
  const lastLineRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const key = winnerKey(winner)

  useEffect(() => {
    if (key === lastKeyRef.current) {
      return
    }
    lastKeyRef.current = key
    clearTimeout(timerRef.current)

    if (!winner) {
      setVisible(false)
      return
    }

    const line = pickPetBubbleLine(moodLines(winner.mood), lastLineRef.current)
    lastLineRef.current = line
    setText(formatPetBubbleText(winner, line, countSuffix))
    setVisible(true)
    timerRef.current = setTimeout(() => setVisible(false), BUBBLE_HOLD_MS)
  }, [key, winner])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return visible ? text : null
}

export function PetBubble(): React.JSX.Element | null {
  const bubbleEnabled = useAppStore((s) => s.settings?.petBubbleEnabled !== false)
  const text = usePetBubbleText()

  if (!bubbleEnabled || !text) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute -top-2 right-full mr-1.5 max-w-[9rem] -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-[10px] font-medium whitespace-nowrap text-popover-foreground shadow-md"
      role="status"
    >
      {text}
    </div>
  )
}

export default PetBubble
