import type { CommunitySyncStatus } from '../../../../shared/community-catalog'
import type {
  CommunityArtifactReceipt,
  CommunityCandidatePlan,
  CommunityCandidateRun,
  CommunityCandidateHistoryPage
} from '../../../../shared/community-candidates'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  CommunityReleaseProof,
  CommunityFeatureAction,
  CommunityFeaturesSnapshot,
  CommunityFeatureHistoryPage
} from '../../../../shared/community-features'
import type {
  CommunityPage,
  CommunityQuery,
  CommunityDetail,
  CommunityRelease,
  CommunityActivity
} from '../../../../shared/community-operations'
export const LOCAL_COMMUNITY_HOST: RuntimeClientTarget = { kind: 'local' }
export function communityClient(target: RuntimeClientTarget) {
  const call = <T>(method: string, params?: unknown): Promise<T> =>
    callRuntimeRpc<T>(target, `community.${method}`, params, { timeoutMs: 300_000 })
  return {
    stageArtifact: (id: string) => call<CommunityArtifactReceipt>('stageArtifact', { id }),
    status: () => call<CommunitySyncStatus>('status'),
    candidateHistory: (offset = 0) =>
      call<CommunityCandidateHistoryPage>('candidateHistory', { offset }),
    verifyRelease: (number: number) => call<CommunityReleaseProof>('verifyRelease', { number }),
    evidence: (id: string) => call<unknown>('evidence', { id }),
    prepareCandidate: () => call<CommunityCandidatePlan>('prepareCandidate'),
    dispatchCandidate: (id: string, repository: string, ref: string) =>
      call<CommunityCandidateRun>('dispatchCandidate', { id, repository, ref }),
    candidateStatus: (id: string) => call<CommunityCandidateRun>('candidateStatus', { id }),
    list: (query: CommunityQuery) => call<CommunityPage>('list', query),
    detail: (number: number, force = false) => call<CommunityDetail>('detail', { number, force }),
    mutate: (action: CommunityFeatureAction) => call<CommunityFeaturesSnapshot>('mutate', action),
    history: (number: number, before?: number) =>
      call<CommunityFeatureHistoryPage>('history', { number, before }),
    features: () => call<CommunityFeaturesSnapshot>('features'),
    refresh: () => call('refresh'),
    cancel: () => call('cancel'),
    releases: () => call<CommunityRelease[]>('releases'),
    activity: () => call<CommunityActivity>('activity'),
    accounts: () => call<{ selected: string | null; users: string[] }>('accounts'),
    account: (user: string | null) => call('account', { user })
  }
}
