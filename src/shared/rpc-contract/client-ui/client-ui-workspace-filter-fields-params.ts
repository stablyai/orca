import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const ClientUiWorkspaceFilterFields = {
  hideDefaultBranchWorkspace: lazyZodSchema(() => z.boolean().optional()),
  hideAutomationGeneratedWorkspaces: lazyZodSchema(() => z.boolean().optional()),
  hideCliCreatedWorkspaces: lazyZodSchema(() => z.boolean().optional()),
  hideDetachedHeadWorkspaces: lazyZodSchema(() => z.boolean().optional()),
  hideWorkspacesFromOtherDevices: lazyZodSchema(() => z.boolean().optional()),
  alwaysShowDefaultBranchWorkspace: lazyZodSchema(() => z.boolean().optional()),
  filterRepoIds: lazyZodSchema(() => z.array(z.string()).optional())
}
