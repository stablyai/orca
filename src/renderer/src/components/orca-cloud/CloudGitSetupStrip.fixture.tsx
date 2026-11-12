import React, { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudGitSetupStripPhase } from './cloud-git-setup-strip-model'
import { CloudGitSetupStripView } from './CloudGitSetupStrip'

const noop = (): void => {}

/** The workspace's tab row, the strip above every pane, then a split tab's two panes. */
function Workspace({
  phase,
  width = 960
}: {
  phase: CloudGitSetupStripPhase
  width?: number
}): React.JSX.Element {
  const [dismissed, setDismissed] = useState(false)
  return (
    <div className="flex h-[260px] flex-col bg-background" style={{ width }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        <span className="rounded-sm bg-muted px-2 py-0.5 text-foreground">Claude</span>
        <span>Terminal 2</span>
      </div>
      {dismissed ? null : (
        <CloudGitSetupStripView
          phase={phase}
          onRestart={noop}
          onDismiss={() => setDismissed(true)}
        />
      )}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border font-mono text-xs text-muted-foreground">
        <div className="p-3">$ git push{'\n'}</div>
        <div className="p-3">$ npm test</div>
      </div>
    </div>
  )
}

/** Git setup failed after create: commits and pushes are refused until a restart installs it. */
export const failed = defineFixture({ width: 1000, render: () => <Workspace phase="failed" /> })

/** Restart pressed: the action is disabled with a spinner until the workspace is back. */
export const restarting = defineFixture({
  width: 1000,
  render: () => <Workspace phase="restarting" />
})

/** The restart's boot still couldn't set it up. */
export const failedAgain = defineFixture({
  width: 1000,
  render: () => <Workspace phase="failedAgain" />
})

/** A narrow window: the full sentence moves to the tooltip. */
export const narrow = defineFixture({
  width: 560,
  render: () => <Workspace phase="failed" width={520} />
})

/** × hides it for this session; the panes take the room back. */
export const dismissed = defineFixture({
  width: 1000,
  render: () => <Workspace phase="failed" />,
  interact: async (frame) => {
    frame
      .querySelector<HTMLButtonElement>('[data-cloud-git-setup-strip] button[aria-label="Dismiss"]')
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
