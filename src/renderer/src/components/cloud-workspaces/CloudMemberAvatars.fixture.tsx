import { defineFixture } from '../../component-fixtures/component-fixture'
import { MemberAvatar, PresenceStack } from './CloudMemberAvatars'
import { DIRECTORY, presence, SELF_ID } from './cloud-workspaces.test-fixture'

function Line({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <span className="w-40 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** Viewing (avatar only), typing (pulsing dot), overflow "+N"; teammates are Follow buttons. */
export const presenceStacks = defineFixture({
  width: 480,
  render: () => (
    <div className="flex flex-col gap-4 p-2">
      <Line label="One viewing">
        <PresenceStack
          presence={[presence('user_grace')]}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onFollow={() => {}}
        />
      </Line>
      <Line label="Typing + viewing">
        <PresenceStack
          presence={[presence('user_grace', 'typing'), presence('user_linus')]}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onFollow={() => {}}
        />
      </Line>
      <Line label="With you (not a button)">
        <PresenceStack
          presence={[presence(SELF_ID), presence('user_mae', 'typing')]}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onFollow={() => {}}
        />
      </Line>
      <Line label="Overflow">
        <PresenceStack
          presence={['user_grace', 'user_linus', 'user_mae', 'user_alan', SELF_ID].map((id) =>
            presence(id)
          )}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onFollow={() => {}}
        />
      </Line>
    </div>
  )
})

/** Follow buttons show the shared focus ring on keyboard focus. */
export const followFocus = defineFixture({
  width: 320,
  render: () => (
    <div className="p-3">
      <PresenceStack
        presence={[presence('user_grace', 'typing'), presence('user_linus')]}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onFollow={() => {}}
      />
    </div>
  ),
  interact: (frame) => frame.querySelector<HTMLButtonElement>('button')?.focus({ focusVisible: true })
})

/** Per-member hues stay stable; sizes used in rows and menus. */
export const avatars = defineFixture({
  width: 360,
  render: () => (
    <div className="flex flex-col gap-3 p-2">
      {(['sm', 'md'] as const).map((size) => (
        <div key={size} className="flex items-center gap-2">
          {[...DIRECTORY.keys()].map((userId) => (
            <MemberAvatar
              key={userId}
              userId={userId}
              directory={DIRECTORY}
              selfId={SELF_ID}
              size={size}
            />
          ))}
        </div>
      ))}
    </div>
  )
})
