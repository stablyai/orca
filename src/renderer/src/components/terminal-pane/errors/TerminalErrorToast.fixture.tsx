import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TerminalErrorToast } from './TerminalErrorToast'

export const spawnFailure = defineFixture({
  width: 680,
  render: () => (
    <div className="relative h-80 bg-background">
      <TerminalErrorToast
        error="Failed to spawn shell /bin/zsh: posix_spawn failed: Resource temporarily unavailable"
        paneOnClient={false}
        onDismiss={() => {}}
      />
    </div>
  )
})

export const recovery = defineFixture({
  width: 420,
  render: () => (
    <div className="relative h-80 bg-background">
      <TerminalErrorToast
        error="terminal_pane_owner_unverified"
        paneOnClient={false}
        onDismiss={() => {}}
        onRetry={async () => true}
        onOpenNewTerminal={() => {}}
      />
    </div>
  )
})

export const smallSplit = defineFixture({
  width: 320,
  interact: (frame) => {
    Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).at(-1)?.focus()
  },
  render: () => (
    <div className="relative h-[50px] bg-background">
      <TerminalErrorToast
        error="terminal_pane_owner_unverified"
        paneOnClient={false}
        onDismiss={() => {}}
        onRetry={async () => true}
        onOpenNewTerminal={() => {}}
      />
    </div>
  )
})
