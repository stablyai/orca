import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { SshConnectionStatus } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import ForgetSshWorkspaceDialog from './ForgetSshWorkspaceDialog'
import type { SshWorkspaceForgetResolution } from './ssh-workspace-forget-resolution'

const WORKTREE_ID = 'repo-1::/home/dev/fix-login'

function unsavedFile(name: string): OpenFile {
  return {
    id: `${WORKTREE_ID}::${name}`,
    filePath: `/home/dev/fix-login/${name}`,
    relativePath: name,
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: true,
    mode: 'edit'
  }
}

function dialogFixture(
  resolution: SshWorkspaceForgetResolution,
  options: { status?: SshConnectionStatus; unsaved?: boolean } = {}
) {
  return defineFixture({
    width: 640,
    store: {
      modalData: { worktreeId: WORKTREE_ID, displayName: 'fix-login', resolution },
      sshTargetLabels: new Map([['devbox-2', 'devbox-2']]),
      removedSshTargetLabels: new Map([['devbox-old', 'devbox-2']]),
      sshConnectionStates: new Map(
        options.status
          ? [
              [
                'devbox-2',
                { targetId: 'devbox-2', status: options.status, error: null, reconnectAttempt: 0 }
              ]
            ]
          : []
      ),
      openFiles: options.unsaved ? [unsavedFile('src/login.ts'), unsavedFile('src/session.ts')] : []
    },
    render: () => (
      <div className="h-[300px] bg-background">
        <ForgetSshWorkspaceDialog />
      </div>
    )
  })
}

export const disconnectedHost = dialogFixture(
  { kind: 'saved', targetId: 'devbox-2' },
  { status: 'disconnected' }
)

export const connectedHostWithUnsavedFiles = dialogFixture(
  { kind: 'saved', targetId: 'devbox-2' },
  { status: 'connected', unsaved: true }
)

export const removedHost = dialogFixture({ kind: 'ghost', targetId: 'devbox-old' })
