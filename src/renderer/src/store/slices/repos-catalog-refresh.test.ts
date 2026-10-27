import { registerReposRuntimeProjectGroupTests } from './repos-runtime-project-groups.spec'
import { registerReposNestedImportRefreshFailureTests } from './repos-nested-import-refresh-failures.spec'
import { registerReposCrossHostRefreshIdentityTests } from './repos-cross-host-refresh-identity.spec'
import { registerReposManualOrderHydrationTests } from './repos-manual-order-hydration.spec'
import { registerReposSetupScriptDismissalTests } from './repos-setup-script-dismissals.spec'

registerReposRuntimeProjectGroupTests()
registerReposNestedImportRefreshFailureTests()
registerReposCrossHostRefreshIdentityTests()
registerReposManualOrderHydrationTests()
registerReposSetupScriptDismissalTests()
