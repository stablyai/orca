import type { RepositoryPaneProps } from './repository-pane-types'
import { RepositorySettingsSession } from './RepositorySettingsSession'
import { getRepoHostIdentity } from '../../../store/slices/repo-host-identity'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'

import { RepositoryPaneView } from './RepositoryPaneView'
export type { RepositoryPaneRepoUpdate } from './repository-pane-types'
export function RepositoryPane(props: RepositoryPaneProps): React.JSX.Element {
  return props.session ? (
    <RepositoryPaneView {...props} session={props.session} />
  ) : (
    <RepositorySettingsSession
      key={getRepoHostIdentity(props.repo)}
      repo={props.repo}
      repoId={props.repo.id}
      hostId={getRepoExecutionHostId(props.repo)}
      isFolder={isFolderRepo(props.repo)}
      updateRepo={props.updateRepo}
    >
      {(session) => <RepositoryPaneView {...props} session={session} />}
    </RepositorySettingsSession>
  )
}
