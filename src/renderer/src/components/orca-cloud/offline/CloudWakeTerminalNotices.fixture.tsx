// Terminal panes around a sleep (JA-15): the pre-sleep scrollback greyed behind "Asleep since",
// and after the wake, the one-line "processes stopped" note. The woke fixtures run the real hint
// rule on the pre-sleep tail: a shell pane offers Rerun with its command, a Claude pane offers
// Restart Claude (never its input placeholder as a command).
import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { CloudAsleepTerminalNotice } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice } from './CloudWokeProcessesNotice'
import { wakeHintForPane, type WakePaneFacts } from '@/lib/orca-cloud/cloud-wake-process-hints'
import { cloudWokeActionFor } from '@/lib/orca-cloud/cloud-wake-hint-action'

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

function WokePane({
  beforeSleepTail,
  facts
}: {
  beforeSleepTail: string[]
  facts?: WakePaneFacts
}): React.JSX.Element {
  const hint = wakeHintForPane(beforeSleepTail, facts)
  return (
    <Pane lines={['ubuntu@sbx:~/hello-world$ ']}>
      {hint ? (
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

// JA-15 P2: Claude was waiting at its input box; its placeholder is not a command to rerun.
export const wokeClaudePaneRestart = defineFixture({
  width: 640,
  render: () => (
    <WokePane
      beforeSleepTail={[
        'ubuntu@sbx:~/hello-world$ . /tmp/orca-launch-3f9a.sh',
        '────────────────────────────────────────────────',
        '> Try "create a util logging.py that..."',
        '────────────────────────────────────────────────',
        '  ? for shortcuts'
      ]}
      facts={{ agentType: 'claude' }}
    />
  )
})
