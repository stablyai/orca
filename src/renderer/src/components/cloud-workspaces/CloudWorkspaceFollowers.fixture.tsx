// PARITY-FOLLOW (design review): the top bar's people on a cloud workspace, beside W-123.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspaceFollowers, workspaceFollowerEntries } from './CloudWorkspaceFollowers'
import { DIRECTORY, presence, SELF_ID } from './cloud-workspaces.test-fixture'

function Bar({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <span className="w-56 text-xs text-muted-foreground">{label}</span>
      {/* Stands in for the top bar's right side: the stack, then the W-123 chip. */}
      <div className="flex h-9 items-center rounded-md border border-border bg-background px-2">
        {children}
        <span className="flex h-6 items-center px-1.5 font-mono text-2xs text-muted-foreground">
          W-582
        </span>
      </div>
    </div>
  )
}

const noop = (): void => {}

/** Creator first; followers; people here now ringed in their color; typing pulses; Follow last. */
export const followerStacks = defineFixture({
  width: 640,
  render: () => (
    <div className="flex flex-col gap-4 p-2">
      <Bar label="Teammate's workspace, not following">
        <CloudWorkspaceFollowers
          entries={workspaceFollowerEntries({
            creatorId: 'user_grace',
            followers: ['user_linus'],
            presence: [presence('user_grace', 'typing')]
          })}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following={false}
          onToggleFollow={noop}
        />
      </Bar>
      <Bar label="Following (hover says Unfollow)">
        <CloudWorkspaceFollowers
          entries={workspaceFollowerEntries({
            creatorId: 'user_grace',
            followers: ['user_linus', SELF_ID],
            presence: [presence('user_linus'), presence(SELF_ID)]
          })}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following
          onToggleFollow={noop}
        />
      </Bar>
      <Bar label="Your own workspace (no Follow)">
        <CloudWorkspaceFollowers
          entries={workspaceFollowerEntries({
            creatorId: SELF_ID,
            followers: ['user_grace', 'user_mae'],
            presence: [presence('user_mae', 'typing')]
          })}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following={null}
        />
      </Bar>
      <Bar label="Many people (+N)">
        <CloudWorkspaceFollowers
          entries={workspaceFollowerEntries({
            creatorId: 'user_grace',
            followers: ['user_linus', 'user_mae', 'user_alan', SELF_ID],
            presence: [presence('user_alan'), presence('user_linus', 'typing')]
          })}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following
          onToggleFollow={noop}
        />
      </Bar>
    </div>
  )
})
