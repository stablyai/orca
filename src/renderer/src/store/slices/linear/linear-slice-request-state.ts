import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearTeam
} from '../../../../../shared/linear/workspace-types'
import { clearLinearMetadataCache } from '../../../hooks/useIssueMetadata'

export type InflightLinearIssueRequest = {
  promise: Promise<LinearIssue | null>
  generation: number
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearListRequest = {
  promise: Promise<LinearIssue[]>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearPlainListRequest = {
  promise: Promise<LinearCollectionResult<LinearIssue>>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearCollectionRequest<T> = {
  promise: Promise<LinearCollectionResult<T>>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearDetailRequest<T> = {
  promise: Promise<T>
  force: boolean
  contextKey: string
  mutationGeneration: number
}

export type InflightLinearTeamRequest = {
  promise: Promise<LinearTeam[]>
  force: boolean
  generation: number
  contextKey: string
  mutationGeneration: number
}

export const linearRequestState = {
  issueRequests: new Map<string, InflightLinearIssueRequest>(),
  searchRequests: new Map<string, InflightLinearListRequest>(),
  listRequests: new Map<string, InflightLinearPlainListRequest>(),
  teamRequests: new Map<string, InflightLinearTeamRequest>(),
  projectRequests: new Map<string, InflightLinearCollectionRequest<LinearProjectSummary>>(),
  projectDetailRequests: new Map<string, InflightLinearDetailRequest<LinearProjectDetail | null>>(),
  projectIssueRequests: new Map<string, InflightLinearCollectionRequest<LinearIssue>>(),
  customViewRequests: new Map<string, InflightLinearCollectionRequest<LinearCustomViewSummary>>(),
  customViewDetailRequests: new Map<
    string,
    InflightLinearDetailRequest<LinearCustomViewSummary | null>
  >(),
  customViewIssueRequests: new Map<string, InflightLinearCollectionRequest<LinearIssue>>(),
  customViewProjectRequests: new Map<
    string,
    InflightLinearCollectionRequest<LinearProjectSummary>
  >(),
  inflightStatusRequest: null as { contextKey: string; promise: Promise<void> } | null,
  statusReadGeneration: 0,
  mutationGeneration: 0,
  cacheGeneration: 0
}

// Named aliases keep action modules focused on behavior while sharing one request registry.
export const inflightIssueRequests = linearRequestState.issueRequests
export const inflightSearchRequests = linearRequestState.searchRequests
export const inflightListRequests = linearRequestState.listRequests
export const inflightTeamRequests = linearRequestState.teamRequests
export const inflightProjectRequests = linearRequestState.projectRequests
export const inflightProjectDetailRequests = linearRequestState.projectDetailRequests
export const inflightProjectIssueRequests = linearRequestState.projectIssueRequests
export const inflightCustomViewRequests = linearRequestState.customViewRequests
export const inflightCustomViewDetailRequests = linearRequestState.customViewDetailRequests
export const inflightCustomViewIssueRequests = linearRequestState.customViewIssueRequests
export const inflightCustomViewProjectRequests = linearRequestState.customViewProjectRequests

export function clearLinearRequestMaps(): void {
  linearRequestState.issueRequests.clear()
  linearRequestState.searchRequests.clear()
  linearRequestState.listRequests.clear()
  linearRequestState.teamRequests.clear()
  linearRequestState.projectRequests.clear()
  linearRequestState.projectDetailRequests.clear()
  linearRequestState.projectIssueRequests.clear()
  linearRequestState.customViewRequests.clear()
  linearRequestState.customViewDetailRequests.clear()
  linearRequestState.customViewIssueRequests.clear()
  linearRequestState.customViewProjectRequests.clear()
}

export function invalidateLinearCaches(): void {
  linearRequestState.cacheGeneration += 1
  clearLinearRequestMaps()
  clearLinearMetadataCache()
}

export function clearLinearIssueCollectionRequestMaps(): void {
  linearRequestState.searchRequests.clear()
  linearRequestState.listRequests.clear()
  linearRequestState.projectIssueRequests.clear()
  linearRequestState.customViewIssueRequests.clear()
}

export function beginLinearMutation(): number {
  linearRequestState.mutationGeneration += 1
  linearRequestState.inflightStatusRequest = null
  return linearRequestState.mutationGeneration
}

export function isCurrentLinearMutation(generation: number): boolean {
  return generation === linearRequestState.mutationGeneration
}

export function nextLinearStatusReadGeneration(): number {
  linearRequestState.statusReadGeneration += 1
  return linearRequestState.statusReadGeneration
}

export function isCurrentLinearStatusRead(generation: number): boolean {
  return generation === linearRequestState.statusReadGeneration
}

export function getLinearCacheGeneration(): number {
  return linearRequestState.cacheGeneration
}

export function getLinearMutationGeneration(): number {
  return linearRequestState.mutationGeneration
}

export function getInflightStatusRequest(): {
  contextKey: string
  promise: Promise<void>
} | null {
  return linearRequestState.inflightStatusRequest
}

export function setInflightStatusRequest(
  request: { contextKey: string; promise: Promise<void> } | null
): void {
  linearRequestState.inflightStatusRequest = request
}
