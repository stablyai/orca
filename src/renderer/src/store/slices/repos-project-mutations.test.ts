import { describe } from 'vitest'
import { registerReposProjectHostLifecycleTests } from './repos-project-host-lifecycle.spec'
import { registerReposProjectHostCapabilityTests } from './repos-project-host-capability.spec'
import { registerReposProjectRuntimeTests } from './repos-project-runtime.spec'
import { registerReposProjectGroupsOwnerRoutingTests } from './repos-project-groups-owner-routing.spec'
import { registerReposProjectGroupsDeleteTests } from './repos-project-groups-delete.spec'
import { registerReposUpdateSerializationTests } from './repos-update-serialization.spec'
import { registerReposProjectGroupCreateRaceTests } from './repos-project-group-create-race.spec'
import { registerReposRemoveProjectPurgeLeakTests } from './repos-remove-project-purge-leak.spec'

describe('repos-project-host-lifecycle', registerReposProjectHostLifecycleTests)
describe('repos-project-host-capability', registerReposProjectHostCapabilityTests)
describe('repos-project-runtime', registerReposProjectRuntimeTests)
describe('repos-project-groups-owner-routing', registerReposProjectGroupsOwnerRoutingTests)
describe('repos-project-groups-delete', registerReposProjectGroupsDeleteTests)
describe('repos-update-serialization', registerReposUpdateSerializationTests)
describe('repos-project-group-create-race', registerReposProjectGroupCreateRaceTests)
describe('repos-remove-project-purge-leak', registerReposRemoveProjectPurgeLeakTests)
