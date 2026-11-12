import { Dialog } from '@/components/ui/dialog'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TeamDeleteDialogView, type TeamDeleteDialogViewProps } from './TeamDeleteDialog'

const noop = (): void => {}
const base: TeamDeleteDialogViewProps = {
  teamName: 'Acme Engineering',
  typed: '',
  submitting: false,
  error: null,
  waiting: false,
  onTypedChange: noop,
  onCancel: noop,
  onSubmit: noop,
  onBlockerAction: noop
}

function View(props: Partial<TeamDeleteDialogViewProps>): React.JSX.Element {
  return (
    <Dialog open>
      <TeamDeleteDialogView {...base} {...props} />
    </Dialog>
  )
}

export const empty = defineFixture({ width: 720, render: () => <View /> })

export const typed = defineFixture({ width: 720, render: () => <View typed="Acme Engineering" /> })

export const mismatch = defineFixture({
  width: 720,
  render: () => (
    <View
      typed="acme engineering"
      error={{ kind: 'mismatch', text: 'The team name doesn’t match.' }}
    />
  )
})

export const unavailable = defineFixture({
  width: 720,
  render: () => (
    <View
      typed="Acme Engineering"
      error={{
        kind: 'message',
        text: 'Couldn’t check the team right now, so nothing was deleted. Try again.'
      }}
    />
  )
})

export const rateLimited = defineFixture({
  width: 720,
  render: () => (
    <View
      typed="Acme Engineering"
      waiting
      error={{ kind: 'message', text: 'Too many attempts. Wait a minute, then try again.' }}
    />
  )
})

export const blockedAtSubmit = defineFixture({
  width: 720,
  render: () => (
    <View
      typed="Acme Engineering"
      error={{
        kind: 'blocked',
        blockers: [
          { code: 'subscription_active', status: 'active' },
          { code: 'workspaces_exist', count: 2 }
        ]
      }}
    />
  )
})
