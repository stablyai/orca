import { conversationHosts, boundedDraftWork } from './chat-draft-removal-batch'
import {
  authorityKey,
  hostAuthorityFromOperationRoute,
  parseHostAuthorityKey
} from '../../../../../../shared/host-authority'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../shared/orca-session-address'
import { getRepoIdFromWorktreeId, worktreeIdentityKey } from '../../../../../../shared/worktree/id'
import type { OrchestrationPartyLocationResult } from '../../../../../../shared/orchestration-caller-status'
import type { AppState } from '../../../types'
import { hostRouteForAuthority } from '@/runtime/rpc/targets/runtime-client-target'
import { callHostRoute } from '@/runtime/rpc/calls/host-route-call'
import { captureHostIdentityFence, isHostIdentityContinued } from '@/store/host-catalog-fencing'
import { nativeChatComposerDraftStorage } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  captureNativeChatDraftRemovalScopes,
  consumeNativeChatDraftRemovalCandidate,
  nativeChatDraftRemovalHosts,
  observeNativeChatDraftRemovalReturns,
  persistNativeChatDraftRemovalScope,
  type NativeChatDraftRemovalScope
} from '@/components/native-chat/native-chat-composer-draft-removal-selection'
import {
  captureNativeChatRemovalJournal,
  settleNativeChatRemovalJournal
} from '@/components/native-chat/native-chat-composer-draft-removal-journal'
import { structuredAgentSessionIdOfDraftScope } from '@/components/native-chat/native-chat-composer-draft-store'
import { captureNativeChatDraftLoadLifetime } from '@/components/native-chat/native-chat-composer-draft-load-attempt'

type DraftState = Pick<AppState, 'unifiedTabsByWorktree'>
type Selector = { workspaceId: string } | { projectId: string }
type RouteInput = { executionHostId: string | null; runtimeEnvironmentId?: string | null }

export function createChatDraftRemovalReceipt(get: () => DraftState, submissionsOnly = false) {
  const exclusions = {
    values: new Map<string, ReadonlySet<string>>(),
    journal: new Set<string>()
  }
  const loading = captureNativeChatDraftLoadLifetime(exclusions)
  const before = conversationHosts(get())
  const authorities = new Map<
    string,
    {
      route: ReturnType<typeof hostRouteForAuthority>
      fence: ReturnType<typeof captureHostIdentityFence>
      workspaces: Set<string>
      projects: Set<string>
      submissionProjects: Set<string>
    }
  >()
  let finished: Promise<void> | undefined
  let stopReturns: (() => void) | undefined
  const receipt = {
    capture(input: RouteInput) {
      const authority = hostAuthorityFromOperationRoute({
        executionHostId: input.executionHostId,
        runtimeEnvironmentId: input.runtimeEnvironmentId ?? null
      })
      if (!authority || authority === 'contradictory') {
        return (_selector: Selector, _mode?: 'submissions') => {}
      }
      const key = authorityKey(authority)
      const route = hostRouteForAuthority(authority)
      const fence = captureHostIdentityFence(route)
      return (selector: Selector, mode?: 'submissions') => {
        if (finished || !isHostIdentityContinued(fence)) {
          return
        }
        let group = authorities.get(key)
        if (!group) {
          group = {
            route,
            fence,
            workspaces: new Set(),
            projects: new Set(),
            submissionProjects: new Set()
          }
          authorities.set(key, group)
        }
        if ('workspaceId' in selector) {
          group.workspaces.add(worktreeIdentityKey(selector.workspaceId))
        } else {
          ;(mode === 'submissions' ? group.submissionProjects : group.projects).add(
            selector.projectId
          )
        }
      }
    },
    finish(): Promise<void> {
      finished ??= (async () => {
        if (authorities.size === 0) {
          return
        }
        const saved = submissionsOnly
          ? new Map<string, unknown>()
          : await nativeChatComposerDraftStorage()
              .loadAll()
              .catch(() => new Map<string, unknown>())
        const journal = submissionsOnly ? [] : captureNativeChatRemovalJournal()
        const scopes = captureNativeChatDraftRemovalScopes(
          saved,
          journal,
          submissionsOnly,
          loading.attempts
        )
        const returns = observeNativeChatDraftRemovalReturns(scopes)
        stopReturns = returns.dispose
        const hostsByScope = new Map(
          [...scopes].map(([scope, captured]) => [
            scope,
            new Set(nativeChatDraftRemovalHosts(captured))
          ])
        )
        for (const captured of scopes.values()) {
          if (captured.destination === captured.scope) {
            continue
          }
          const target = hostsByScope.get(captured.destination)
          for (const host of hostsByScope.get(captured.scope) ?? []) {
            target?.add(host)
          }
        }
        const after = conversationHosts(get())
        const candidates = new Map<
          string,
          {
            sessionId: string
            authority: string
            destination: string
            scopes: NativeChatDraftRemovalScope[]
          }
        >()
        for (const captured of scopes.values()) {
          const sessionId = structuredAgentSessionIdOfDraftScope(captured.destination)
          if (!sessionId || !isOrcaSessionId(sessionId)) {
            continue
          }
          const evidence = [
            hostsByScope.get(captured.scope),
            hostsByScope.get(captured.destination),
            before.get(sessionId),
            after.get(sessionId)
          ]
          if (evidence.some((hosts) => hosts && hosts.size > 1)) {
            continue
          }
          const hosts = new Set<string>()
          for (const held of evidence) {
            for (const host of held ?? []) {
              hosts.add(host)
            }
          }
          if (hosts.size !== 1) {
            continue
          }
          const host = hosts.values().next().value
          const authority = parseHostAuthorityKey(host)
          if (!authority) {
            continue
          }
          const key = authorityKey(authority)
          if (!authorities.has(key)) {
            continue
          }
          const identity = JSON.stringify([key, sessionId])
          const candidate = candidates.get(identity) ?? {
            sessionId,
            authority: key,
            destination: captured.destination,
            scopes: []
          }
          candidate.scopes.push(captured)
          candidates.set(identity, candidate)
        }
        const selected: NativeChatDraftRemovalScope[] = []
        const unavailable = new Set<string>()
        const admitted = new Set([...candidates.values()].map(({ destination }) => destination))
        for (const [destination, stream] of returns.streams) {
          if (!admitted.has(destination)) {
            stream.stop()
            stream.release()
          }
        }
        await boundedDraftWork([...candidates.values()], async (candidate) => {
          const stream = returns.streams.get(candidate.destination)
          const owner = authorities.get(candidate.authority)
          if (
            !owner ||
            !isHostIdentityContinued(owner.fence) ||
            !isOrcaSessionId(candidate.sessionId)
          ) {
            stream?.stop()
            stream?.release()
            return
          }
          const endpoint = JSON.stringify(owner.route.target)
          if (unavailable.has(endpoint)) {
            stream?.stop()
            stream?.release()
            return
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const result = await Promise.race([
              callHostRoute<OrchestrationPartyLocationResult>(
                owner.route,
                'orchestration.partyLocation',
                { address: formatOrcaSessionAddress(candidate.sessionId) },
                { timeoutMs: 15_000 }
              ),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  unavailable.add(endpoint)
                  reject(new Error('Membership unavailable'))
                }, 15_000)
              })
            ])
            stream?.stop()
            const location = result?.location
            if (
              !isHostIdentityContinued(owner.fence) ||
              location?.kind !== 'chat' ||
              location.sessionId !== candidate.sessionId ||
              !(
                owner.workspaces.has(worktreeIdentityKey(location.worktreeId)) ||
                owner.projects.has(getRepoIdFromWorktreeId(location.worktreeId)) ||
                owner.submissionProjects.has(getRepoIdFromWorktreeId(location.worktreeId))
              )
            ) {
              return
            }
            const returnsOnly =
              submissionsOnly ||
              !(
                owner.workspaces.has(worktreeIdentityKey(location.worktreeId)) ||
                owner.projects.has(getRepoIdFromWorktreeId(location.worktreeId))
              )
            selected.push(
              ...consumeNativeChatDraftRemovalCandidate(
                candidate.scopes,
                stream,
                exclusions,
                returnsOnly
              )
            )
          } catch {
            unavailable.add(endpoint)
            /* Unavailable membership is retained; removal has already succeeded. */
          } finally {
            clearTimeout(timer)
            stream?.stop()
            stream?.release()
          }
        })
        if (!submissionsOnly && selected.length) {
          const settlement = settleNativeChatRemovalJournal(
            journal === null
              ? null
              : [...journal, ...selected.flatMap((scope) => scope.derivedJournal)],
            new Set(selected.map(({ scope }) => scope))
          )
          if (settlement.ok) {
            await boundedDraftWork(selected, async (captured) => {
              const result = await persistNativeChatDraftRemovalScope(captured)
              if (!result.ok) {
                console.warn('[native-chat-drafts] selected draft cleanup could not be saved')
              }
            })
          } else {
            console.warn('[native-chat-drafts] selected draft journal cleanup could not be saved')
          }
        }
      })()
        .catch(() => {
          console.warn(
            '[native-chat-drafts] removal cleanup was incomplete; unverified saved content was retained'
          )
        })
        .finally(() => {
          authorities.clear()
          before.clear()
          loading.dispose()
          stopReturns?.()
        })
      return finished
    }
  }
  return receipt
}

export type ChatDraftRemovalReceipt = ReturnType<typeof createChatDraftRemovalReceipt>
