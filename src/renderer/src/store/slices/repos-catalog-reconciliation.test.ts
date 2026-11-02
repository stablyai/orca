import { describe } from 'vitest'
import { registerReposCatalogMergeIdentityTests } from './repos-catalog-merge-identity.spec'
import { registerReposRefreshIdentityTests } from './repos-refresh-identity.spec'
import { registerReposCatalogNotificationsTests } from './repos-catalog-notifications.spec'
import { registerReposStaleFetchTests } from './repos-stale-fetch.spec'
import { registerReposSharedProjectBadgeColorTests } from './repos-shared-project-badge-color.spec'
import { registerReposAllHostsFolderWorkspacesTests } from './repos-all-hosts-folder-workspaces.spec'
import { registerReposRuntimeVisibilityDefaultsTests } from './repos-runtime-visibility-defaults.spec'

describe('repos-catalog-merge-identity', registerReposCatalogMergeIdentityTests)
describe('repos-refresh-identity', registerReposRefreshIdentityTests)
describe('repos-catalog-notifications', registerReposCatalogNotificationsTests)
describe('repos-stale-fetch', registerReposStaleFetchTests)
describe('repos-shared-project-badge-color', registerReposSharedProjectBadgeColorTests)
describe('repos-all-hosts-folder-workspaces', registerReposAllHostsFolderWorkspacesTests)
describe('repos-runtime-visibility-defaults', registerReposRuntimeVisibilityDefaultsTests)
