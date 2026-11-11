import { useCallback, useEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type {
  LocalCommandDecision,
  LocalCommandPrompt
} from '../../../../shared/local-commands/local-command-desktop-types'

/** Matches main's floor: a click or Enter that lands before a person could read the prompt is ignored. */
const READ_DELAY_MS = 600

function timeoutLabel(seconds: number, t: ReturnType<typeof useTranslate>): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60
    return t('localCommands.prompt.timeoutMinutes', 'Stops after {{count}} minutes', {
      count: minutes,
      defaultValue_one: 'Stops after {{count}} minute'
    })
  }
  return t('localCommands.prompt.timeoutSeconds', 'Stops after {{count}} seconds', {
    count: seconds,
    defaultValue_one: 'Stops after {{count}} second'
  })
}

/** Letters outside printable ASCII are tinted and named, so a lookalike can't pass for the real one. */
function MarkedText({ text }: { text: string }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let plain = ''
  let index = 0
  for (const char of text) {
    if (/[\t\n\x20-\x7e]/.test(char)) {
      plain += char
      continue
    }
    if (plain) {
      parts.push(plain)
      plain = ''
    }
    const code = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
    parts.push(
      <mark key={index++} title={code} className="rounded-sm bg-destructive/20 text-destructive">
        {char}
      </mark>
    )
  }
  if (plain) {
    parts.push(plain)
  }
  return <>{parts}</>
}

export function LocalCommandApprovalDialogView({
  prompt,
  waitingCount,
  ready,
  busy,
  onDecide
}: {
  prompt: LocalCommandPrompt
  /** Other requests queued behind this one. */
  waitingCount: number
  ready: boolean
  busy: boolean
  onDecide: (decision: LocalCommandDecision) => void
}): React.JSX.Element {
  const t = useTranslate()
  const disabled = !ready || busy
  return (
    <DialogContent
      surface="security"
      className="max-w-lg sm:max-w-lg"
      showCloseButton={false}
      // Default focus is Deny: a stray Enter must never run a command.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        document.getElementById('local-command-deny')?.focus()
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-sm">
          {t('localCommands.prompt.title', 'Run a command on this computer?')}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {prompt.agent
            ? t(
                'localCommands.prompt.bodyAgent',
                '{{agent}} in the cloud workspace {{workspace}} asks to run this command here. Allow it only if you understand what it does.',
                { agent: prompt.agent, workspace: prompt.workspaceLabel }
              )
            : t(
                'localCommands.prompt.body',
                'An agent in the cloud workspace {{workspace}} asks to run this command here. Allow it only if you understand what it does.',
                { workspace: prompt.workspaceLabel }
              )}
        </DialogDescription>
      </DialogHeader>

      {prompt.reason ? (
        <figure className="space-y-1">
          <figcaption className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('localCommands.prompt.reasonLabel', "Agent's reason")}
          </figcaption>
          <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground break-words">
            {prompt.reason}
          </blockquote>
        </figure>
      ) : null}

      <div className="space-y-2 rounded-md border border-border/70 bg-muted/35 px-3 py-2">
        <div>
          <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('localCommands.prompt.commandLabel', 'Command')}
          </div>
          <pre
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground scrollbar-sleek"
            data-testid="local-command-text"
          >
            <MarkedText text={prompt.command} />
          </pre>
        </div>
        <div>
          <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('localCommands.prompt.folderLabel', 'Folder')}
          </div>
          <p className="break-all font-mono text-xs text-foreground">
            <MarkedText text={prompt.cwd} />
          </p>
        </div>
      </div>

      {prompt.hasNonAscii ? (
        <p className="flex items-start gap-2 text-xs text-foreground">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          {t(
            'localCommands.prompt.nonAscii',
            'This command has characters outside plain ASCII, which can look like other letters. Check it carefully.'
          )}
        </p>
      ) : null}
      {prompt.shared ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'localCommands.prompt.shared',
            "Teammates share this workspace, so a teammate's message may have led to this request."
          )}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {timeoutLabel(prompt.timeoutSec, t)}
        {' · '}
        {t(
          'localCommands.prompt.environment',
          'Runs with /bin/sh, without your shell profile or secrets'
        )}
        {waitingCount > 0
          ? ` · ${t('localCommands.prompt.waiting', '{{count}} more waiting', { count: waitingCount })}`
          : null}
      </p>

      <DialogFooter>
        <Button
          id="local-command-deny"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide('deny')}
        >
          {t('localCommands.prompt.deny', 'Deny')}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => onDecide('always-allow')}>
          {t('localCommands.prompt.alwaysAllow', 'Always allow this command')}
        </Button>
        <Button disabled={disabled} onClick={() => onDecide('allow-once')}>
          {t('localCommands.prompt.allowOnce', 'Allow once')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

/** One request at a time, oldest first. Closing the dialog any other way denies it. */
export function LocalCommandApprovalDialogHost(): React.JSX.Element | null {
  const [prompts, setPrompts] = useState<LocalCommandPrompt[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const current = prompts[0] ?? null
  const currentId = current?.id ?? null
  const decidedRef = useRef<string | null>(null)

  useEffect(() => {
    const api = window.api.localCommands
    if (!api) {
      return
    }
    let disposed = false
    const stop = api.onPrompts((next) => {
      if (!disposed) {
        setPrompts(next)
      }
    })
    void api
      .getPrompts()
      .then((initial) => !disposed && setPrompts(initial))
      .catch(() => {})
    return () => {
      disposed = true
      stop()
    }
  }, [])

  useEffect(() => {
    setReady(false)
    setBusy(false)
    if (!currentId) {
      return
    }
    const timer = setTimeout(() => setReady(true), READ_DELAY_MS)
    return () => clearTimeout(timer)
  }, [currentId])

  const decide = useCallback(
    (decision: LocalCommandDecision) => {
      const api = window.api.localCommands
      if (!api || !currentId || decidedRef.current === currentId) {
        return
      }
      if (decision !== 'deny' && !ready) {
        return
      }
      decidedRef.current = currentId
      setBusy(true)
      void api
        .decide(currentId, decision)
        .catch(() => ({ ok: false }))
        .then((result) => {
          if (!result.ok) {
            // Refused (too soon, or turned off meanwhile): main keeps or drops the prompt itself.
            decidedRef.current = null
            setBusy(false)
          }
        })
    },
    [currentId, ready]
  )

  if (!current) {
    return null
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          decide('deny')
        }
      }}
    >
      <LocalCommandApprovalDialogView
        key={current.id}
        prompt={current}
        waitingCount={prompts.length - 1}
        ready={ready}
        busy={busy}
        onDecide={decide}
      />
    </Dialog>
  )
}
