// GA-P3t (Neil): every strip, banner and notice variant on the surfaces it sits on, so the contrast
// rule is checked in one place. Light default (#fff, the app background), light on #fafafa (sidebar
// and lighter surfaces), and dark via --theme both.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudAgentSignInStrip } from '../agent-sign-in-strip/CloudAgentSignInStrip'
import type {
  CloudStripModel,
  CloudStripStatus
} from '../agent-sign-in-strip/cloud-agent-strip-model'
import { PaneTopWarningBanner } from '../terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'
import { CloudWorkspaceNotice, CloudVersionSkewNotice } from '../orca-cloud/CloudWorkspaceNotice'
import { CloudToastCard } from '../orca-cloud/cloud-toast-stack'
import { OrcaCloudQueuedPromptView } from '../orca-cloud/OrcaCloudQueuedPrompt'
import { Button } from './button'

const noop = (): void => {}
const ACTIONS = {
  primary: noop,
  submitCode: noop,
  pasteCode: noop,
  useCode: noop,
  useApiKey: noop,
  cancel: noop
}

function stripModel(status: CloudStripStatus, title: string, detail: string): CloudStripModel {
  return {
    status,
    title,
    detail,
    description: null,
    primary: {
      label: status === 'warning' ? 'Renew' : 'Set up once',
      action: { kind: 'setUpOnce' }
    },
    code: null,
    paste: null,
    otherWays: false,
    announcement: title
  }
}

const STRIPS: [CloudStripStatus, string, string][] = [
  ['warning', 'Your Claude sign-in expired', 'Renew to keep working. Your conversation is kept.'],
  ['setup', 'Claude isn’t set up for Orca Cloud', 'Set up once. Every cloud workspace uses it.'],
  ['error', 'Couldn’t restart Claude', 'Try again. Your conversation is kept.'],
  ['busy', 'Restarting…', 'Your files are kept, and Orca resumes your agents once it is back.']
]

function Variants(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {STRIPS.map(([status, title, detail]) => (
        <div key={status} className="relative" data-banner-variant={`strip-${status}`}>
          <CloudAgentSignInStrip
            model={stripModel(status, title, detail)}
            prompt={null}
            actions={ACTIONS}
          />
        </div>
      ))}
      <div className="relative [&_.pane-top-banner]:!static" data-banner-variant="pane-warning">
        <PaneTopWarningBanner
          title="Orca woke this workspace"
          body="2 processes were running before it slept."
          primaryAction={<Button size="xs">Show</Button>}
          onDismiss={noop}
        />
      </div>
      <div className="relative [&_.pane-top-banner]:!static" data-banner-variant="pane-neutral">
        <PaneTopWarningBanner
          tone="neutral"
          title="This pane runs on Dev server"
          body="Its terminal history stays there."
          primaryAction={<Button size="xs">Open</Button>}
        />
      </div>
      <div className="flex gap-3">
        <CloudWorkspaceNotice
          notice={{ kind: 'unresponsive' }}
          restarting={false}
          onRestart={noop}
        />
        <CloudVersionSkewNotice
          direction="desktop-older"
          onCheckForUpdates={noop}
          onCreateWorkspace={noop}
          onDismiss={noop}
        />
      </div>
      <div className="flex gap-3">
        <CloudToastCard
          view={{
            priority: 'warning',
            lines: [
              {
                key: 'push',
                text: 'Orca Cloud can read octocat/Hello-World but can’t push yet.',
                description: 'Install the Orca GitHub App on octocat to push.'
              }
            ]
          }}
          onDismiss={noop}
        />
        <CloudToastCard
          view={{
            priority: 'info',
            lines: [
              { key: 'env', text: 'Environment checked', description: 'Node 24 and pnpm ready.' }
            ]
          }}
          onDismiss={noop}
        />
      </div>
      <div className="flex gap-3">
        <div className="w-80">
          <OrcaCloudQueuedPromptView
            agentName="Claude"
            prompt="Fix the flaky login test"
            editable={false}
            held
            onQueue={noop}
          />
        </div>
        <div className="w-80">
          <OrcaCloudQueuedPromptView
            agentName="Claude"
            prompt="Fix the flaky login test"
            editable
            onQueue={noop}
          />
        </div>
      </div>
    </div>
  )
}

/** On the app background (#fff in light: the default and a white pane are the same surface). */
export const onBackground = defineFixture({
  width: 900,
  render: () => (
    <div className="bg-background p-4">
      <Variants />
    </div>
  )
})

/** On the lighter-grey surfaces (#fafafa: sidebar, cards); the worst case for fills. */
export const onLightGrey = defineFixture({
  width: 900,
  render: () => (
    <div className="bg-[#fafafa] p-4 dark:bg-card">
      <Variants />
    </div>
  )
})
