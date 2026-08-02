import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

function canLoadFullFirstPrompt(
  session: Pick<AiVaultSession, 'executionHostId' | 'filePath'>
): boolean {
  return (
    session.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    Boolean(session.filePath.trim()) &&
    typeof window.api.aiVault.getFirstUserPrompt === 'function'
  )
}

export function FirstPromptCard({
  session,
  previewText
}: {
  session: AiVaultSession
  /** Short preview from list scan; replaced by the full on-demand body when available. */
  previewText: string
}): React.JSX.Element {
  // Loading starts true when an on-demand re-parse is possible so the mount effect
  // does not need a sync setState (react-doctor: no-adjust-state-on-prop-change).
  const [fullText, setFullText] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => canLoadFullFirstPrompt(session))
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const fullTextRef = useRef<string | null>(null)
  const loadPromiseRef = useRef<Promise<string | null> | null>(null)
  // Bumped on unmount/cleanup so a late response cannot write into a dead card.
  const generationRef = useRef(0)

  const { agent, codexHome, executionHostId, filePath, sessionId } = session

  const loadFullPrompt = useCallback((): Promise<string | null> => {
    if (fullTextRef.current != null) {
      return Promise.resolve(fullTextRef.current)
    }
    if (loadPromiseRef.current) {
      return loadPromiseRef.current
    }

    if (!canLoadFullFirstPrompt({ executionHostId, filePath })) {
      return Promise.resolve(null)
    }
    const getFirstUserPrompt = window.api.aiVault.getFirstUserPrompt

    const generation = generationRef.current
    const isStale = (): boolean => generationRef.current !== generation
    const promise = getFirstUserPrompt({
      agent,
      filePath,
      sessionId,
      executionHostId,
      codexHome
    })
      .then((result) => {
        if (isStale()) {
          return null
        }
        const prompt = result.prompt?.trim() || null
        fullTextRef.current = prompt
        setFullText(prompt)
        return prompt
      })
      .catch(() => {
        if (isStale()) {
          return null
        }
        fullTextRef.current = null
        setFullText(null)
        return null
      })
      .finally(() => {
        // A stale settle must not clear the live request's dedupe handle.
        if (isStale()) {
          return
        }
        setLoading(false)
        loadPromiseRef.current = null
      })

    loadPromiseRef.current = promise
    return promise
  }, [agent, codexHome, executionHostId, filePath, sessionId])

  // Why: list rows never carry the full first prompt (payload/perf). Load the
  // untruncated body once when this details card mounts. Parent keys this card by
  // session.id so session switches remount with fresh state.
  useEffect(() => {
    void loadFullPrompt()
    return () => {
      generationRef.current += 1
    }
  }, [loadFullPrompt])

  const displayText = (fullText ?? previewText).trim()
  const showEmpty = !loading && !displayText

  const copyFirstPrompt = (): void => {
    setCopying(true)
    // Why: never copy the 220-char list preview when the full body is still
    // in flight — wait for the on-demand re-parse, then fall back only if null.
    void loadFullPrompt()
      .then((loaded) => {
        const copyText = (loaded ?? previewText).trim()
        if (!copyText) {
          return
        }
        return window.api.ui.writeClipboardText(copyText).then(() => {
          setCopied(true)
          toast.success(
            translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.firstPromptCopied',
              'First prompt copied'
            )
          )
          window.setTimeout(() => {
            setCopied(false)
          }, 1400)
        })
      })
      .catch(() => {
        // Clipboard / load failures leave the button idle so the user can retry.
      })
      .finally(() => {
        setCopying(false)
      })
  }

  return (
    <div className="rounded-md border border-border/70 bg-foreground/[0.04] px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          <span>
            {translate('auto.components.right.sidebar.AiVaultSessionDetails.userRole', 'You')}
          </span>
          {loading || copying ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground/70" />
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          draggable={false}
          disabled={copying || (!displayText && !loading)}
          onClick={(event) => {
            event.stopPropagation()
            copyFirstPrompt()
          }}
          className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copyFirstPrompt',
            'Copy first prompt'
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied
            ? translate('auto.components.right.sidebar.AiVaultSessionDetails.copied', 'Copied')
            : translate('auto.components.right.sidebar.AiVaultSessionDetails.copy', 'Copy')}
        </Button>
      </div>
      {showEmpty ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.noFirstPromptAvailable',
            'No first prompt available'
          )}
        </p>
      ) : (
        <p className="scrollbar-sleek max-h-48 select-text overflow-y-auto whitespace-pre-wrap text-[12px] leading-[1.35] text-foreground/90 [overflow-wrap:anywhere]">
          {displayText ||
            translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.loadingFirstPrompt',
              'Loading first prompt…'
            )}
        </p>
      )}
    </div>
  )
}
