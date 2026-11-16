import { defineFixture } from '../../component-fixtures/component-fixture'
import { MemberAvatar } from './CloudMemberAvatars'
import { DIRECTORY, SELF_ID } from './cloud-workspaces.test-fixture'

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
