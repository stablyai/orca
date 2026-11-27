import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

export const DirectWorkItemSetupDialog = lazyWithRetry(
  () =>
    import('../setup/DirectWorkItemSetupDialog').then((module) => ({
      default: module.DirectWorkItemSetupDialog
    })),
  { reloadKey: 'composer-direct-work-item-setup' }
)

export const AgentSettingsDialog = lazyWithRetry(
  () => import('@/components/agent/AgentSettingsDialog'),
  { reloadKey: 'composer-agent-settings' }
)

// Keep Add Project’s clone/SSH machinery outside the composer entry render, matching App loading.
export const HostedAddRepoDialog = lazyWithRetry(
  () => import('@/components/sidebar/project-admission/dialog/AddRepoDialog'),
  { reloadKey: 'composer-add-repo' }
)
