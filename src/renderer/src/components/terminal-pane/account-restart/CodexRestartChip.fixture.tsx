import { defineFixture } from '../../../component-fixtures/component-fixture'
import CodexRestartChip from './CodexRestartChip'

// Invented accounts; the overlay sits over a pane-sized box as it does over a live terminal.
function notice(
  previousAccountLabel: string,
  nextAccountLabel: string,
  restartBlockedBy?: 'manual'
) {
  return {
    codexRestartNoticeByPtyId: {
      'fixture-pty': {
        previousAccountLabel,
        nextAccountLabel,
        ...(restartBlockedBy ? { restartBlockedBy } : {})
      }
    }
  }
}

function Pane(): React.JSX.Element {
  return (
    <div className="relative h-80 bg-background">
      <CodexRestartChip ptyId="fixture-pty" onReturnFocus={() => {}} />
    </div>
  )
}

export const accountSwitched = defineFixture({
  width: 960,
  store: notice('dana@example.com', 'robin@example.org'),
  render: () => <Pane />
})

export const accountSwitchedNarrow = defineFixture({
  width: 360,
  store: notice('dana@example.com', 'robin@example.org'),
  render: () => <Pane />
})

export const accountSwitchedLongLabels = defineFixture({
  width: 640,
  store: notice(
    'a.very.long.workspace.account.name@research-team.example.com',
    'another.long.account.label.for.billing@operations.example.org'
  ),
  render: () => <Pane />
})

export const manualRestart = defineFixture({
  width: 960,
  store: notice('dana@example.com', 'robin@example.org', 'manual'),
  render: () => <Pane />
})

export const manualRestartNarrow = defineFixture({
  width: 360,
  store: notice('dana@example.com', 'robin@example.org', 'manual'),
  render: () => <Pane />
})
