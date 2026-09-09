import type { JSX, ReactNode } from 'react'
import { ClaudeIcon } from '@/components/status-bar/icons'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  BROWSER_PROMPT_TEXT,
  browserPhaseAtLeast,
  type BrowserVisualPhase
} from './browser-animated-visual-phase'

type TerminalEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'working' }
  | { kind: 'ok'; content: ReactNode }
  | { kind: 'tool'; tool: string; arg: string }
  | { kind: 'tool-muted'; tool: string; muted: string }

type PhasedTerminalEntry = {
  id: string
  entry: TerminalEntry
  minPhase: BrowserVisualPhase
}

function terminalEntries(): readonly PhasedTerminalEntry[] {
  return [
    {
      id: 'change-prompt',
      entry: { kind: 'prompt', text: BROWSER_PROMPT_TEXT },
      minPhase: 'working'
    },
    { id: 'working', entry: { kind: 'working' }, minPhase: 'working' },
    {
      id: 'updated',
      entry: {
        kind: 'ok',
        content: (
          <>
            {translate(
              'auto.components.feature.wall.BrowserAnimatedVisual.4fa59ca545',
              '✓ Updated'
            )}{' '}
            <code className="text-emerald-600 dark:text-emerald-400">
              {translate(
                'auto.components.feature.wall.BrowserAnimatedVisual.051c97d15a',
                '.pp-card[data-card="starter"] .pp-cta'
              )}
            </code>
          </>
        )
      },
      minPhase: 'updated'
    },
    {
      id: 'verify-prompt',
      entry: {
        kind: 'prompt',
        text: 'Let me click Try free to verify it still works.'
      },
      minPhase: 'verify-intent'
    },
    {
      id: 'click',
      entry: { kind: 'tool', tool: 'click', arg: '"Try free"' },
      minPhase: 'click-press'
    },
    {
      id: 'screenshot',
      entry: { kind: 'tool-muted', tool: 'screenshot', muted: '(capturing page)' },
      minPhase: 'screenshot-line'
    },
    {
      id: 'verified',
      entry: {
        kind: 'ok',
        content: translate(
          'auto.components.feature.wall.BrowserAnimatedVisual.eb88125c6f',
          '✓ Verified — Try free still works.'
        )
      },
      minPhase: 'verified'
    }
  ]
}

export function BrowserAgentVerificationPane(props: {
  phase: BrowserVisualPhase
  splitVisible: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card font-mono text-[10px] text-card-foreground shadow-xs transition-[opacity,transform] duration-500',
        props.splitVisible ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0'
      )}
    >
      <div className="flex h-5 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 text-[9.5px] font-medium text-foreground">
        <ClaudeIcon size={11} />
        <span>
          {translate('auto.components.feature.wall.BrowserAnimatedVisual.6e4616d039', 'Claude')}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1 px-2 py-2 leading-snug">
        {terminalEntries().map(({ id, entry, minPhase }) => (
          <TerminalLine key={id} visible={browserPhaseAtLeast(props.phase, minPhase)}>
            <TerminalEntryView entry={entry} />
          </TerminalLine>
        ))}
      </div>
    </div>
  )
}

function TerminalEntryView(props: { entry: TerminalEntry }): JSX.Element {
  const { entry } = props
  if (entry.kind === 'prompt') {
    return (
      <span className="text-card-foreground">
        <span className="text-muted-foreground">
          {translate('auto.components.feature.wall.BrowserAnimatedVisual.f2034c4930', '>')}
        </span>{' '}
        {entry.text}
      </span>
    )
  }
  if (entry.kind === 'working') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500 dark:bg-emerald-400" />
        {translate('auto.components.feature.wall.BrowserAnimatedVisual.0ce7c24b4d', 'Working…')}
      </span>
    )
  }
  if (entry.kind === 'ok') {
    return <span className="text-emerald-600 dark:text-emerald-400">{entry.content}</span>
  }
  if (entry.kind === 'tool') {
    return (
      <span>
        <span className="text-violet-600 dark:text-violet-400">{entry.tool}</span>{' '}
        <span className="text-emerald-600 dark:text-emerald-400">{entry.arg}</span>
      </span>
    )
  }
  return (
    <span>
      <span className="text-violet-600 dark:text-violet-400">{entry.tool}</span>{' '}
      <span className="text-muted-foreground">{entry.muted}</span>
    </span>
  )
}

function TerminalLine(props: { visible: boolean; children: ReactNode }): JSX.Element {
  return (
    <span
      className={cn('transition-opacity duration-300', props.visible ? 'opacity-100' : 'opacity-0')}
    >
      {props.children}
    </span>
  )
}
