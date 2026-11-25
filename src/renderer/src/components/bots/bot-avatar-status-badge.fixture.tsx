import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  BotAvatarStatusBadge,
  botAvatarBadgeCutout,
  type BotAvatarBadgeState
} from './bot-avatar-status-badge'

const states: [string, BotAvatarBadgeState][] = [
  ['Available', { status: 'active', sleeping: false }],
  ['Done', { status: 'done', sleeping: false }],
  ['Sleeping', { status: 'active', sleeping: true }],
  ['Working', { status: 'working', sleeping: false }],
  ['Monitoring', { status: 'monitoring', sleeping: false }],
  ['Needs permission', { status: 'permission', sleeping: false }],
  ['Failed', { status: 'failed', sleeping: false }],
  ['Interrupted', { status: 'interrupted', sleeping: false }],
  ['Couldn’t confirm', { status: 'unconfirmed', sleeping: false }],
  ['Paused', { status: 'inactive', sleeping: false }],
  ['Usage limit', { status: 'active', sleeping: false, stopTip: 'Usage limit reached' }],
  ['No status', { status: null, sleeping: false }]
]

export const statesOverview = defineFixture({
  width: 640,
  render: () => (
    <div className="grid grid-cols-2 gap-4 bg-worktree-sidebar p-4 text-worktree-sidebar-foreground">
      {states.map(([name, state]) => (
        <div key={name} className="flex items-center gap-2">
          <span className="relative shrink-0">
            <span
              className="flex size-8 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground"
              style={botAvatarBadgeCutout(state)}
            >
              A
            </span>
            <BotAvatarStatusBadge {...state} />
          </span>
          <span className="text-sm">{name}</span>
        </div>
      ))}
    </div>
  )
})
