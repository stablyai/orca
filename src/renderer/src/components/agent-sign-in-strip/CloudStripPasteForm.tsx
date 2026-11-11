// The strip's paste input: a claude.ai code (RA-11), a setup-token (PC-3b), or the code Claude's
// sign-in page shows for the waiting setup-token (Set up once). Secrets are masked; a setup code is
// cleared as soon as it's sent and goes on its own when a whole one is pasted.
import React, { useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CloudStripModel } from './cloud-agent-strip-model'

/** A pasted value that is a whole code (`code#state`) or the callback URL carrying one. */
export function looksLikeWholeSetupCode(value: string): boolean {
  const text = value.trim()
  return /^https:\/\/\S+[?&]code=/.test(text) || /^[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]{8,}$/.test(text)
}

export function CloudStripPasteForm({
  paste,
  onSubmitCode,
  onSubmitSetupCode
}: {
  paste: NonNullable<CloudStripModel['paste']>
  onSubmitCode: (code: string) => void
  onSubmitSetupCode?: (code: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [code, setCode] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const setupCode = paste.setupCode
  const busy = paste.submitting
  // A refused code: the field is already empty; keep the person's place in it.
  useEffect(() => {
    if (paste.refusal) {
      inputRef.current?.focus()
    }
  }, [paste.refusal])
  const send = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed || busy) {
      return
    }
    if (setupCode && onSubmitSetupCode) {
      // Never kept on screen or in state once it's on its way.
      setCode('')
      onSubmitSetupCode(trimmed)
      return
    }
    onSubmitCode(trimmed)
  }
  return (
    <form
      className="flex min-w-0 items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        send(code)
      }}
    >
      <Input
        ref={inputRef}
        aria-label={paste.secretLabel ?? t('agentSignInStrip.pasteLabel', 'Code from claude.ai')}
        placeholder={setupCode?.placeholder}
        type={paste.secretLabel ? 'password' : undefined}
        autoComplete={paste.secretLabel ? 'off' : undefined}
        aria-invalid={paste.refusal ? true : undefined}
        disabled={setupCode ? busy : undefined}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onPaste={(event) => {
          if (!setupCode) {
            return
          }
          const pasted = event.clipboardData.getData('text')
          if (looksLikeWholeSetupCode(pasted)) {
            event.preventDefault()
            send(pasted)
          }
        }}
        variant="code"
        className="h-7 min-w-0"
      />
      <Button
        type="submit"
        size="xs"
        disabled={setupCode ? busy || !code.trim() : undefined}
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
      >
        {setupCode ? setupCode.submitLabel : t('agentSignInStrip.continue', 'Continue')}
      </Button>
    </form>
  )
}
