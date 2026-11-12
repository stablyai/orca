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

type StripRow = {
  status: CloudStripStatus
  title: string
  detail: string
  /** The real strip's action for that state; null where it has none (restarting). */
  action: string | null
  noClose?: boolean
}

function stripModel(row: StripRow): CloudStripModel {
  return {
    status: row.status,
    title: row.title,
    detail: row.detail,
    description: null,
    primary: row.action
      ? { label: row.action, action: { kind: row.status === 'warning' ? 'renew' : 'setUpOnce' } }
      : null,
    code: null,
    paste: null,
    otherWays: false,
    noClose: row.noClose,
    announcement: row.title
  }
}

// The real states' copy and actions (sign-in strip, RA-11 restart, PC-3b setup).
const STRIPS: StripRow[] = [
  {
    status: 'warning',
    title: 'Your Claude sign-in expired',
    detail: 'Renew to keep working. Your conversation is kept.',
    action: 'Renew'
  },
  {
    status: 'setup',
    title: 'Claude isn’t set up for Orca Cloud',
    detail: 'Set up once. Every cloud workspace uses it.',
    action: 'Set up once'
  },
  {
    status: 'error',
    title: 'Couldn’t restart Claude',
    detail: 'Your conversation is kept.',
    action: 'Try again'
  },
  {
    status: 'busy',
    title: 'Restarting Claude…',
    detail: 'Your conversation is kept.',
    action: null,
    noClose: true
  }
]

function Variants(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {STRIPS.map((row) => (
        <div key={row.status} className="relative" data-banner-variant={`strip-${row.status}`}>
          <CloudAgentSignInStrip model={stripModel(row)} prompt={null} actions={ACTIONS} />
        </div>
      ))}
      {/* Warning tone: the Codex shared-server notice's real copy. */}
      <div className="relative [&_.pane-top-banner]:!static" data-banner-variant="pane-warning">
        <PaneTopWarningBanner
          title="This Codex is sharing a server with your other Codex tabs"
          body="Codex sessions that share a server can end together, and agent status can be wrong."
          primaryAction={
            <Button size="xs" variant="outline">
              Fix
            </Button>
          }
          onDismiss={noop}
        />
      </div>
      {/* Neutral tone: the shipped Woke-up bar (CloudWokeProcessesNotice). */}
      <div className="relative [&_.pane-top-banner]:!static" data-banner-variant="pane-neutral">
        <PaneTopWarningBanner
          tone="neutral"
          title="Woke up · processes stopped while asleep"
          primaryAction={
            <Button size="xs" variant="outline">
              Rerun <span className="font-mono">pnpm dev</span>
            </Button>
          }
          onDismiss={noop}
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
