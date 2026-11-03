import { translate } from '@/i18n/i18n'
import type { SystemSleepHold } from '../../../../shared/computer-awake-mode'

// 'unchecked' is macOS only: the setting could not be read, so the bar must not claim the lid note.
export type SystemSleepHoldState = 'none' | 'unchecked' | 'system'

export function isMacUserAgent(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return userAgent.includes('Mac')
}

export function resolveSystemSleepHoldState(
  hold: SystemSleepHold | null,
  isMac: boolean,
  checkPossible = false
): SystemSleepHoldState {
  if (hold?.sleepDisabled === 'yes') {
    return 'system'
  }
  const unanswered = hold === null && checkPossible
  return (hold?.sleepDisabled === 'unknown' || unanswered) && isMac ? 'unchecked' : 'none'
}

export function isSleepHeld(state: SystemSleepHoldState): boolean {
  return state === 'system'
}

export function getSleepHoldLabel(): string {
  return translate('auto.components.status.bar.CaffeinateStatusSegment.awakeLabel', 'Awake')
}

export function getSleepHoldSentence(): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdSystem',
    'Kept awake by a system setting'
  )
}

export function getSleepHoldLidClosed(): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdLidClosed',
    'This Mac (where Orca runs) stays awake with the lid closed.'
  )
}

export function getSleepHoldUnchecked(): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdUnchecked',
    "Couldn't check this Mac's sleep setting"
  )
}

// Why: ja and zh end a sentence with 。 and no space, so the join is translated per locale.
export function joinHoldSentences(first: string, second: string): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdSentenceJoin',
    '{{first}}. {{second}}',
    { first, second }
  )
}

// Why: the first part already ends with its own full stop, so only the gap differs by locale.
export function appendHoldSentence(first: string, second: string): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdSentenceAppend',
    '{{first}} {{second}}',
    { first, second }
  )
}

// Why: ja and zh close a sentence with 。, so the trailing full stop is translated per locale.
export function endHoldSentence(sentence: string): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.holdSentenceEnd',
    '{{sentence}}.',
    { sentence }
  )
}

export function getOrcaOwnStatus(status: string): string {
  return translate(
    'auto.components.status.bar.CaffeinateStatusSegment.orcaOwnStatus',
    'Orca keep-awake: {{status}}.',
    { status }
  )
}
