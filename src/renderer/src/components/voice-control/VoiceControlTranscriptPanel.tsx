import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { MousePointerClick, SendHorizontal, X } from 'lucide-react'
import type { VoiceTranscriptEntry } from '../../../../shared/voice-control-types'
import {
  hydrateVoiceControlTranscript,
  setVoiceControlTranscriptPanelOpen,
  useVoiceControlSessionId,
  useVoiceControlState,
  useVoiceControlTranscriptEntries,
  useVoiceControlTranscriptPanelOpen
} from './voice-control-store'

/** Stable row identity: the entry's timestamp, kind, and content — never its position. */
function transcriptEntryKey(entry: VoiceTranscriptEntry): string {
  const content =
    entry.kind === 'command' ? entry.command : entry.kind === 'ui' ? entry.summary : entry.text
  return `${entry.ts}:${entry.kind}:${content}`
}

function TranscriptEntryRow({ entry }: { entry: VoiceTranscriptEntry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div data-testid="transcript-entry-user" className="text-popover-foreground">
          <span className="font-medium text-muted-foreground">
            {translate(
              'auto.components.voice.control.VoiceControlTranscriptPanel.510ef08415',
              'You:'
            )}
          </span>{' '}
          {entry.text}
        </div>
      )
    case 'assistant':
      return (
        <div data-testid="transcript-entry-assistant" className="text-popover-foreground">
          {entry.text}
        </div>
      )
    case 'command':
      return (
        <div
          data-testid="transcript-entry-command"
          className="rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-xs"
        >
          <div className="text-muted-foreground">
            {'$ '}
            {entry.command}
          </div>
          {entry.output.trim() ? (
            <pre className="mt-1 max-h-32 overflow-auto scrollbar-sleek whitespace-pre-wrap text-popover-foreground">
              {entry.output.trim()}
            </pre>
          ) : null}
        </div>
      )
    case 'update':
      return (
        <div data-testid="transcript-entry-update" className="text-muted-foreground">
          <span className="font-medium">{entry.spokenName}</span>
          {' — '}
          {entry.text}
        </div>
      )
    case 'ui':
      return (
        <div
          data-testid="transcript-entry-ui"
          className="flex items-center gap-1.5 text-muted-foreground"
        >
          <MousePointerClick className="size-3 shrink-0" />
          {entry.summary}
        </div>
      )
  }
}

/**
 * The pill-anchored transcript: everything the coordinator heard, said, ran, and relayed,
 * live. Backfills from the durable log on open so a restart loses nothing the user saw.
 */
export function VoiceControlTranscriptPanel() {
  const state = useVoiceControlState()
  const sessionId = useVoiceControlSessionId()
  const open = useVoiceControlTranscriptPanelOpen()
  const entries = useVoiceControlTranscriptEntries()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')

  // The composer: a voice session's text lane — paste a code, type instead of speaking.
  const sendDraft = (): void => {
    const text = draft.trim()
    if (!text || !sessionId || state !== 'live') {
      return
    }
    setDraft('')
    void window.api.voiceControl.sendUserText(sessionId, text)
  }

  // Backfill once per open: live entries already in the feed are a suffix of the log.
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void window.api.voiceControl.getTranscript().then((backfill) => {
      if (!cancelled) {
        hydrateVoiceControlTranscript(backfill)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Follow the tail as entries stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries.length])

  // The pill vanishes when the session ends; an orphaned panel would float over nothing.
  if (!open || state === 'idle') {
    return null
  }

  return (
    <div
      data-testid="voice-control-transcript-panel"
      role="log"
      aria-label={translate(
        'auto.components.voice.control.VoiceControlTranscriptPanel.8aeb00a62d',
        'Voice transcript'
      )}
      className="fixed bottom-24 left-1/2 z-50 flex max-h-80 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover/95 text-sm text-popover-foreground shadow-floating backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-medium">
          {translate(
            'auto.components.voice.control.VoiceControlTranscriptPanel.8aeb00a62d',
            'Voice transcript'
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.voice.control.VoiceControlTranscriptPanel.6ccf1cddd4',
            'Close transcript'
          )}
          onClick={() => setVoiceControlTranscriptPanelOpen(false)}
        >
          <X className="size-3" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="flex flex-col gap-1.5 overflow-y-auto scrollbar-sleek px-3 py-2"
      >
        {entries.length === 0 ? (
          <div className="py-2 text-center text-muted-foreground">
            {translate(
              'auto.components.voice.control.VoiceControlTranscriptPanel.e992981744',
              'No transcript yet — say something.'
            )}
          </div>
        ) : (
          entries.map((entry) => (
            <TranscriptEntryRow key={transcriptEntryKey(entry)} entry={entry} />
          ))
        )}
      </div>
      {state === 'live' ? (
        <form
          className="flex items-center gap-2 border-t border-border px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            sendDraft()
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={translate(
              'auto.components.voice.control.VoiceControlTranscriptPanel.ab8ecc45ba',
              'Type or paste a message…'
            )}
            aria-label={translate(
              'auto.components.voice.control.VoiceControlTranscriptPanel.ab8ecc45ba',
              'Type or paste a message…'
            )}
            className="h-7"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-xs"
            disabled={!draft.trim()}
            aria-label={translate(
              'auto.components.voice.control.VoiceControlTranscriptPanel.a9a6d9904a',
              'Send message'
            )}
          >
            <SendHorizontal className="size-3" />
          </Button>
        </form>
      ) : null}
    </div>
  )
}
