import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'
import { WorktreeCreate } from './worktree-create-params'

const create = WorktreeCreate.shape

/** A recipe's provisioned project root, adopted on its host as the main worktree's workspace. */
export const WorktreeAdoptProvisionedRoot = z.object({
  repo: create.repo,
  nameWasGenerated: create.nameWasGenerated,
  displayName: create.displayName,
  displayNameKind: create.displayNameKind,
  baseBranch: create.baseBranch,
  compareBaseRef: create.compareBaseRef,
  branchNameOverride: create.branchNameOverride,
  sparseCheckout: create.sparseCheckout,
  linkedIssue: create.linkedIssue,
  linkedPR: create.linkedPR,
  linkedLinearIssue: create.linkedLinearIssue,
  linkedLinearIssueWorkspaceId: create.linkedLinearIssueWorkspaceId,
  linkedLinearIssueOrganizationUrlKey: create.linkedLinearIssueOrganizationUrlKey,
  linkedGitLabMR: create.linkedGitLabMR,
  linkedGitLabIssue: create.linkedGitLabIssue,
  linkedBitbucketPR: create.linkedBitbucketPR,
  linkedAzureDevOpsPR: create.linkedAzureDevOpsPR,
  linkedGiteaPR: create.linkedGiteaPR,
  linkedWorkItem: create.linkedWorkItem,
  linkedItems: create.linkedItems,
  linkedTaskSourceContext: create.linkedTaskSourceContext,
  workspaceStatus: create.workspaceStatus,
  manualOrder: create.manualOrder,
  pushTarget: create.pushTarget,
  createdWithAgent: create.createdWithAgent,
  name: z.string().min(1, 'Missing workspace name'),
  expectedPath: z.string().min(1, 'Missing provisioned project root'),
  expectedRefHead: OptionalString
})
