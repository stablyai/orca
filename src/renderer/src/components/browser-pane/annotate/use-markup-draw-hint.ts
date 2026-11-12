import { useOncePerInstallHint } from '@/hooks/use-once-per-install-hint'

// Offer Draw once per install independently of capped tours; keep it open until dismissal or ineligibility, with no timeout.
const MARKUP_DRAW_HINT_SEEN_KEY = 'orca.browser.markup-draw-hint-seen'

// Decline the hint when storage is unavailable to avoid nagging on every open.
function claimFirstView(): boolean {
  try {
    if (window.localStorage.getItem(MARKUP_DRAW_HINT_SEEN_KEY) === 'true') {
      return false
    }
    window.localStorage.setItem(MARKUP_DRAW_HINT_SEEN_KEY, 'true')
    return true
  } catch {
    return false
  }
}

export type MarkupDrawHint = { hintOpen: boolean; dismissHint: () => void }

export function useMarkupDrawHint(eligible: boolean): MarkupDrawHint {
  return useOncePerInstallHint(eligible, claimFirstView)
}
