import { useState } from 'react'
import { toast } from 'sonner'
import { normalizeKagiSessionLink } from '../../../../shared/browser-url'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

export type KagiSessionLinkDraftState = {
  persisted: string
  value: string
}

export function createKagiSessionLinkDraftState(persisted: string): KagiSessionLinkDraftState {
  return {
    persisted,
    value: persisted
  }
}

export function resolveKagiSessionLinkDraftState(
  state: KagiSessionLinkDraftState,
  persisted: string
): KagiSessionLinkDraftState {
  return state.persisted === persisted ? state : createKagiSessionLinkDraftState(persisted)
}

export function KagiSessionLinkForm(): React.JSX.Element {
  const browserKagiSessionLink = useAppStore((s) => s.browserKagiSessionLink)
  const setBrowserKagiSessionLink = useAppStore((s) => s.setBrowserKagiSessionLink)
  const persistedDraft = browserKagiSessionLink ?? ''
  const [draftState, setDraftState] = useState(() =>
    createKagiSessionLinkDraftState(persistedDraft)
  )
  const resolvedDraftState = resolveKagiSessionLinkDraftState(draftState, persistedDraft)

  // Why: the Kagi token is edited as a masked draft so accidental typing or
  // external settings updates do not immediately overwrite the persisted
  // secret; when the stored secret changes, reconcile before commit.
  if (resolvedDraftState !== draftState) {
    setDraftState(resolvedDraftState)
  }
  const draft = resolvedDraftState.value
  const setDraft = (value: string): void => {
    setDraftState((current) => ({ ...current, value }))
  }

  const save = (): void => {
    const trimmed = draft.trim()
    if (!trimmed) {
      setBrowserKagiSessionLink(null)
      setDraftState(createKagiSessionLinkDraftState(''))
      toast.success('Kagi session link cleared.')
      return
    }
    const normalized = normalizeKagiSessionLink(trimmed)
    if (!normalized) {
      toast.error('Enter a Kagi private session link from https://kagi.com/search?token=...')
      return
    }
    setBrowserKagiSessionLink(normalized)
    setDraftState(createKagiSessionLinkDraftState(normalized))
    toast.success('Kagi session link saved.')
  }

  return (
    <form
      className="flex flex-col items-end gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <p className="max-w-72 text-right text-[11px] leading-snug text-muted-foreground">
        Optional private session link for Kagi auth.
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://kagi.com/search?token=..."
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Kagi private session link"
          className="h-7 w-72 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" className="h-7 text-xs">
          Save
        </Button>
        {browserKagiSessionLink ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => {
              setBrowserKagiSessionLink(null)
              setDraftState(createKagiSessionLinkDraftState(''))
              toast.success('Kagi session link cleared.')
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  )
}
