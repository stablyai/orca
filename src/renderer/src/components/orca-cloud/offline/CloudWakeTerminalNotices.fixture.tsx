// Terminal panes around a sleep (JA-15): the pre-sleep scrollback greyed behind "Asleep since",
// and after the wake, the one-line "processes stopped" note with Rerun.
import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { CloudAsleepTerminalNotice } from './CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice } from './CloudWokeProcessesNotice'

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

export const wokeProcessesStopped = defineFixture({
  width: 640,
  render: () => (
    <Pane lines={['ubuntu@sbx:~/hello-world$ ']}>
      <CloudWokeProcessesNotice
        command="python3 -m http.server 8000"
        onRerun={noop}
        onDismiss={noop}
      />
    </Pane>
  )
})
