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

const MISSING_FOLDER_ERROR =
  'Working directory "/Volumes/Projects/app" does not exist. It may have been deleted or is on an unmounted volume (cwd: /Volumes/Projects/app, arch: arm64, platform: darwin 24.0.0, orca: 1.0.0).'

export const missingFolder = defineFixture({
  width: 680,
  render: () => (
    <div className="relative h-72 bg-background">
      <TerminalErrorToast error={MISSING_FOLDER_ERROR} onDismiss={() => {}} />
    </div>
  )
})
