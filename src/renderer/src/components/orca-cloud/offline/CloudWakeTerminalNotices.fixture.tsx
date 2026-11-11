// Terminal panes around a sleep (JA-15): the pre-sleep scrollback greyed behind "Asleep since",
// and after the wake, the one-line "processes stopped" note. The woke fixtures run the real hint
// rule on the pre-sleep tail: a shell pane offers Rerun with its command. A Claude pane shows no
// strip once the host relaunched Claude (WAKE-1), and Restart Claude only when, after the grace,
// the pane sits at a bare shell (never its input placeholder as a command).
import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { CloudAsleepTerminalNotice } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice } from './CloudWokeProcessesNotice'
import {
  endsAtShellPrompt,
  wakeHintForPane,
  type WakePaneFacts
} from '@/lib/orca-cloud/cloud-wake-process-hints'
import { cloudWokeActionFor } from '@/lib/orca-cloud/cloud-wake-hint-action'
import {
  AGENT_RELAUNCH_GRACE_MS,
  wokeAgentStripState
} from '@/lib/orca-cloud/cloud-woke-agent-strip'

const noop = (): void => {}

function Pane({
  children,
  lines
}: {
  children: React.ReactNode
  lines: string[]
}): React.JSX.Element {
  return (
    <div className="relative h-[300px] overflow-hidden rounded-md border border-border bg-background">
      <pre className="absolute inset-0 m-0 px-4 py-3 font-mono text-xs leading-5 text-foreground">
        {lines.join('\n')}
      </pre>
      {children}
    </div>
  )
}

const beforeSleep = [
  'ubuntu@sbx:~/hello-world$ ls',
  'README  index.html',
  'ubuntu@sbx:~/hello-world$ python3 -m http.server 8000',
  'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...',
  '127.0.0.1 - - [10/Nov/2026 15:08:41] "GET / HTTP/1.1" 200 -'
]

export const asleepTerminalHistory = defineFixture({
  width: 640,
  render: () => (
    <Pane lines={beforeSleep}>
      <CloudAsleepTerminalNotice
        workspaceId="ws"
        asleepSince={new Date(2026, 10, 10, 15, 10).getTime()}
        // Five 20px lines from 12px down: right under "GET / HTTP/1.1".
        historyEndPx={116}
      />
    </Pane>
  )
})

const ASLEEP_AT = Date.UTC(2026, 10, 10, 15, 10)
const BARE_SHELL = ['ubuntu@sbx:~/hello-world$ ']

function WokePane({
  beforeSleepTail,
  afterWake = BARE_SHELL,
  facts,
  relaunchedAt = null
}: {
  beforeSleepTail: string[]
  /** The pane after the wake, 15 s in. */
  afterWake?: string[]
  facts?: WakePaneFacts
  /** When the relaunched agent reported in, or null when it never did. */
  relaunchedAt?: number | null
}): React.JSX.Element {
  const hint = wakeHintForPane(beforeSleepTail, facts)
  const agentState =
    hint && 'restartAgent' in hint
      ? wokeAgentStripState({
          capturedAt: ASLEEP_AT,
          evidenceAt: relaunchedAt,
          sinceLiveMs: AGENT_RELAUNCH_GRACE_MS,
          paneAtShellPrompt: () => endsAtShellPrompt(afterWake)
        })
      : null
  const show = hint !== null && (agentState === null || agentState === 'restart')
  return (
    <Pane lines={afterWake}>
      {show ? (
        <CloudWokeProcessesNotice
          action={cloudWokeActionFor(hint)}
          onAction={noop}
          onDismiss={noop}
        />
      ) : null}
    </Pane>
  )
}

export const wokeProcessesStopped = defineFixture({
  width: 640,
  render: () => <WokePane beforeSleepTail={beforeSleep} />
})

// Claude was waiting at its input box when the workspace went to sleep.
const claudeAtInput = [
  'ubuntu@sbx:~/hello-world$ . /tmp/orca-launch-3f9a.sh',
  '────────────────────────────────────────────────',
  '> Try "create a util logging.py that..."',
  '────────────────────────────────────────────────',
  '  ? for shortcuts'
]

// RA-WAKE: the host relaunched Claude (it reported in after the wake); no strip over it.
export const wokeClaudeRelaunched = defineFixture({
  width: 640,
  render: () => (
    <WokePane
      beforeSleepTail={claudeAtInput}
      afterWake={claudeAtInput.slice(1)}
      facts={{ agentType: 'claude' }}
      relaunchedAt={ASLEEP_AT + 120_000}
    />
  )
})

// Fallback: 15 s after the wake, Claude never came back and the pane is a bare shell.
export const wokeClaudeNotRelaunched = defineFixture({
  width: 640,
  render: () => (
    <WokePane
      beforeSleepTail={claudeAtInput}
      afterWake={['No conversation found with session ID: 9b1f…', 'ubuntu@sbx:~/hello-world$ ']}
      facts={{ agentType: 'claude' }}
    />
  )
})
