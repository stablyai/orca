import type {
  GiteaAssignableUser,
  GiteaPRFile,
  GiteaWorkItem,
  GiteaWorkItemDetails
} from '../../../../shared/gitea-types'
import type {
  GitLabAssignableUser,
  GitLabMRFile,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../../../shared/gitlab-types'

type GiteaItemFields = Omit<GiteaWorkItem, 'repoId'>

/** Gitea reviewers are addressed by username; the shared dialog addresses them by numeric id. */
export class GiteaReviewerIds {
  private readonly idByUsername = new Map<string, number>()
  private readonly usernameById = new Map<number, string>()

  toDialogUser(user: GiteaAssignableUser): GitLabAssignableUser {
    return {
      id: this.idFor(user.username, user.id),
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl
    }
  }

  usernameFor(id: number): string | undefined {
    return this.usernameById.get(id)
  }

  private idFor(username: string, preferredId?: number): number {
    const known = this.idByUsername.get(username)
    if (known !== undefined) {
      return known
    }
    const id = preferredId ?? -(this.idByUsername.size + 1)
    this.idByUsername.set(username, id)
    this.usernameById.set(id, username)
    return id
  }
}

export function giteaItemToDialogItem(item: GiteaItemFields & { repoId: string }): GitLabWorkItem {
  return {
    id: item.id,
    type: item.type === 'pr' ? 'mr' : 'issue',
    number: item.number,
    title: item.title,
    state: item.state === 'open' ? 'opened' : item.state,
    url: item.url,
    labels: item.labels,
    updatedAt: item.updatedAt,
    author: item.author,
    ...(item.branchName ? { branchName: item.branchName } : {}),
    ...(item.baseRefName ? { baseRefName: item.baseRefName } : {}),
    ...(item.isCrossRepository !== undefined ? { isCrossRepository: item.isCrossRepository } : {}),
    repoId: item.repoId
  }
}

function giteaFileToDialogFile(file: GiteaPRFile): GitLabMRFile {
  return { ...file, status: file.status === 'deleted' ? 'removed' : file.status }
}

export function giteaDetailsToDialogDetails(
  details: GiteaWorkItemDetails,
  repoId: string,
  reviewerIds: GiteaReviewerIds
): GitLabWorkItemDetails {
  const approvedBy = details.approvalState?.approvedBy ?? []
  return {
    item: giteaItemToDialogItem({ ...details.item, repoId }),
    body: details.body,
    comments: details.comments,
    ...(details.headSha ? { headSha: details.headSha } : {}),
    ...(details.baseSha ? { baseSha: details.baseSha, startSha: details.baseSha } : {}),
    ...(details.files ? { files: details.files.map(giteaFileToDialogFile) } : {}),
    ...(details.pipelineJobs
      ? {
          pipelineJobs: details.pipelineJobs.map((job) => ({
            id: job.id,
            ...(job.runId !== undefined ? { pipelineId: job.runId } : {}),
            name: job.name,
            stage: job.stage,
            status: job.status,
            webUrl: job.webUrl,
            duration: job.duration
          }))
        }
      : {}),
    ...(details.reviewers
      ? { reviewers: details.reviewers.map((user) => reviewerIds.toDialogUser(user)) }
      : {}),
    // Gitea has no approval quota; only a recorded approval is worth surfacing.
    ...(approvedBy.length > 0
      ? {
          approvalState: {
            approvalsRequired: null,
            approvalsLeft: 0,
            approvedBy: approvedBy.map((user) => reviewerIds.toDialogUser(user)),
            rules: []
          }
        }
      : {})
  }
}
