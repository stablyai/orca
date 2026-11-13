import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

export function maskedHint(hint: string | null): string {
  return hint ? `••••${hint}` : '••••'
}

export type CloudSecretHintGap = 'admins_only' | 'too_short'

/**
 * Why a row has no ending. The server keeps one only for values of 16+ characters, and sends it
 * only to the people who may write the scope (`hintVisible` mirrors `canWrite`), so those two
 * cases are the only ways a hint can be missing. `canSeeHints` null means the caller isn't known yet.
 */
export function cloudSecretHintGap(
  hint: string | null,
  canSeeHints: boolean | null
): CloudSecretHintGap | null {
  if (hint || canSeeHints === null) {
    return null
  }
  return canSeeHints ? 'too_short' : 'admins_only'
}

export function cloudSecretHintGapCopy(gap: CloudSecretHintGap, t: Translate): string {
  return gap === 'admins_only'
    ? t('cloudSecrets.hint.adminsOnly', 'Only owners and admins see the last characters')
    : t('cloudSecrets.hint.tooShort', 'Short values are fully hidden')
}

/** "••••x7Qa", or "••••" with a tooltip saying why there is no ending. */
export function CloudSecretHint({
  hint,
  canSeeHints,
  defaultOpen
}: {
  hint: string | null
  canSeeHints: boolean | null
  /** Fixtures only: show the tooltip without hovering. */
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const gap = cloudSecretHintGap(hint, canSeeHints)
  const label = hint
    ? t('cloudSecrets.list.hintLabel', 'Value hidden, ends in {{hint}}', { hint })
    : gap
      ? cloudSecretHintGapCopy(gap, t)
      : t('cloudSecrets.list.hiddenLabel', 'Value hidden')
  return (
    <>
      {gap ? (
        <Tooltip defaultOpen={defaultOpen}>
          <TooltipTrigger asChild>
            <span aria-hidden data-hint-gap={gap} className="cursor-default">
              {maskedHint(hint)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        <span aria-hidden>{maskedHint(hint)}</span>
      )}
      <span className="sr-only">{label}</span>
    </>
  )
}
