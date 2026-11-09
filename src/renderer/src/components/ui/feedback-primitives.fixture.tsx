import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'
import { Button } from './button'
import { InlineError } from './inline-error'
import { Skeleton } from './skeleton'

export const skeletonCard = defineFixture({
  width: 520,
  render: () => (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <Skeleton shape="circle" className="size-6" />
        <Skeleton className="h-3.5 w-40" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-8 w-28" />
    </div>
  )
})

export const inlineErrorNarrow = defineFixture({
  width: 300,
  render: () => (
    <div className="w-[260px] space-y-3">
      <InlineError
        density="compact"
        title="Payment failed"
        detail="New sandboxes can't start."
        action={
          <Button type="button" variant="outline" size="xs">
            Update payment method
          </Button>
        }
      />
      <InlineError
        density="compact"
        tone="neutral"
        title="Orca Cloud needs a Team plan"
        retryLabel="Try again"
        onRetry={() => {}}
      />
    </div>
  )
})

export const inlineError = defineFixture({
  width: 520,
  render: () => (
    <div className="space-y-3">
      <InlineError
        title="Couldn't load API keys."
        detail="Orca Cloud didn't answer. Your keys are unchanged."
        retryLabel="Try again"
        onRetry={() => {}}
      />
      <InlineError
        title="Couldn't load secrets."
        retryLabel="Try again"
        onRetry={() => {}}
        retrying
      />
      <InlineError tone="neutral" title="Status unavailable right now." />
      <InlineError
        density="compact"
        title="Couldn't load shared links."
        detail="Sign in to Orca to see them."
        action={
          <Button type="button" variant="outline" size="xs">
            Sign in
          </Button>
        }
      />
    </div>
  )
})

function SegmentedDemo(): React.JSX.Element {
  const [scope, setScope] = useState('personal')
  const [preset, setPreset] = useState('read')
  return (
    <div className="space-y-3">
      <SettingsSegmentedControl
        ariaLabel="Secrets scope"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'personal', label: 'Personal' },
          { value: 'shared', label: 'Shared' },
          { value: 'repo', label: 'Repository' },
          { value: 'effective', label: 'What workspaces get' }
        ]}
      />
      <SettingsSegmentedControl
        ariaLabel="Key access"
        size="sm"
        value={preset}
        onChange={setPreset}
        options={[
          { value: 'read', label: 'Read only' },
          { value: 'full', label: 'Full access' },
          { value: 'custom', label: 'Custom', disabled: true, tooltip: 'Owners and admins only' }
        ]}
      />
    </div>
  )
}

export const segmentedControl = defineFixture({
  width: 520,
  render: () => <SegmentedDemo />
})
