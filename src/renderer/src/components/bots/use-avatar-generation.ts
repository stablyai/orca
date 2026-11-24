// Generating an avatar with a local image-capable agent. The run lives in the request store: unmounting
// the hook releases it, which ends a run for a bot not yet made and lets one for a bot that exists land.
import { useEffect, useRef, useState } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import { useAppStore } from '@/store'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent,
  AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { describesRealPerson } from '../../../../shared/avatar-generation/avatar-generation-prompt'
import { pickAvatarAgent } from '../../../../shared/avatar-generation/avatar-generation-agent-choice'
import { refreshAvatarCapability, useAvatarCapability } from './avatar-generation-capability-store'
import {
  avatarRequestPending,
  cancelAvatarRequest,
  handOffAvatarRequest,
  releaseAvatarRequest,
  startAvatarRequest,
  type AvatarRequestHost,
  type AvatarRequestOwner,
  type GeneratedAvatar
} from './avatar-generation-requests'

export type { GeneratedAvatar } from './avatar-generation-requests'

const NO_AGENTS: readonly AvatarImageAgentStatus[] = []

export type AvatarGenerationRun =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'running'; agent: AvatarImageAgent }
  | { kind: 'error'; failure: AvatarGenerationFailure; agent?: AvatarImageAgent }

function rememberAgent(agent: AvatarImageAgent): void {
  const { settings, updateSettings } = useAppStore.getState()
  if (settings && settings.avatarGenerationAgent !== agent) {
    void updateSettings({ avatarGenerationAgent: agent })
  }
}

let draftCount = 0

export type AvatarGenerationOptions = { owner?: () => AvatarRequestOwner; onFailed?: () => void }
/** A Generate face's: `background` when its host keeps it above the picker's popover. */
export type GenerateFaceOptions = AvatarGenerationOptions & { background?: boolean }

/** A name for a bot not yet made, for its picture choices in the ledger (`noteBotPictureChoice`). */
export function newAvatarDraftKey(): string {
  draftCount += 1
  return `avatar-draft:${draftCount}`
}

/** `onStart` runs once a run is accepted (after the description is checked), before the agent is asked.
 *  `onResult`'s `apply` says whether the host should place the picture itself (see AvatarRequestHost).
 *  `owner` is read as each run starts; absent, the picture is for a bot not yet made. `onFailed` runs
 *  as a run of this host's fails, after its error is set. */
export function useAvatarGeneration(
  onResult: (result: GeneratedAvatar, apply: boolean) => void,
  onStart?: () => void,
  { owner, onFailed }: AvatarGenerationOptions = {}
): {
  agents: readonly AvatarImageAgentStatus[]
  /** null while no capable agent was found. */
  agent: AvatarImageAgent | null
  selectAgent: (agent: AvatarImageAgent) => void
  run: AvatarGenerationRun
  /** Kept while the hook is mounted, through later runs that fail or are canceled. */
  result: GeneratedAvatar | null
  generate: (description: string) => void
  cancel: () => void
  clearError: () => void
  /** Create took the dialog's picture: a run still going follows the bot being made. */
  handOff: (
    target: Parameters<typeof handOffAvatarRequest>[1]
  ) => ReturnType<typeof handOffAvatarRequest>
  /** Releases a run still going (as unmounting does) and forgets the last result. */
  reset: () => void
  /** Names this host's picture choices for a bot not yet made, for `noteBotPictureChoice`. */
  choiceKey: string
} {
  const agents = useAvatarCapability() ?? NO_AGENTS
  const remembered = useAppStore((store) => store.settings?.avatarGenerationAgent)
  const [chosen, setChosen] = useState<AvatarImageAgent | null>(null)
  const agent = pickAvatarAgent(agents, chosen ?? remembered)
  const [run, setRun] = useState<AvatarGenerationRun>({ kind: 'idle' })
  const [result, setResult] = useState<GeneratedAvatar | null>(null)
  const current = useRef<string | null>(null)
  const lastSaved = useRef<Bot | undefined>(undefined)
  // A result can land after the face moved; the host decides then whether it applies.
  const latest = useRef({ onResult, onStart, owner, onFailed })
  useEffect(() => {
    latest.current = { onResult, onStart, owner, onFailed }
  })
  // This host's own picture choices, for a bot not yet made.
  const [draftKey] = useState(newAvatarDraftKey)

  useEffect(() => {
    // Picks up agents installed or signed in since the last check, for the next open's layout.
    refreshAvatarCapability()
    return () => {
      if (current.current) {
        releaseAvatarRequest(current.current)
        current.current = null
      }
    }
  }, [])

  const selectAgent = (next: AvatarImageAgent): void => {
    setChosen(next)
    rememberAgent(next)
    if (run.kind === 'error') {
      setRun({ kind: 'idle' })
    }
  }

  const generate = (description: string): void => {
    const text = description.trim()
    if (!text || !agent || avatarRequestPending(current.current)) {
      return
    }
    if (describesRealPerson(text)) {
      setRun({ kind: 'error', failure: 'real-person' })
      return
    }
    latest.current.onStart?.()
    let id: string | null = null
    const ours = (): boolean => id !== null && current.current === id
    const host: AvatarRequestHost = {
      landed: (made, apply) => {
        if (!ours()) {
          return
        }
        const saving = avatarRequestPending(id)
        if (!saving) {
          current.current = null
        }
        setResult(made)
        setRun({ kind: saving ? 'saving' : 'idle' })
        latest.current.onResult(made, apply)
      },
      failed: (failure, failedAgent) => {
        if (ours()) {
          current.current = null
          setRun({ kind: 'error', failure, agent: failedAgent })
          latest.current.onFailed?.()
        }
      },
      ended: (saved) => {
        if (ours()) {
          lastSaved.current = saved
          current.current = null
          setRun({ kind: 'idle' })
        }
      }
    }
    const target: AvatarRequestOwner = latest.current.owner?.() ?? { kind: 'draft', key: draftKey }
    const saved = lastSaved.current
    const owner =
      target.kind === 'bot' &&
      saved?.id === target.bot.id &&
      saved.hostId === target.bot.hostId &&
      (saved.avatarRevision ?? 0) > (target.bot.avatarRevision ?? 0)
        ? { ...target, bot: saved }
        : target
    id = startAvatarRequest({
      description: text,
      agent,
      owner,
      host
    })
    if (!id) {
      return
    }
    current.current = id
    rememberAgent(agent)
    setRun({ kind: 'running', agent })
  }

  const cancel = (): void => {
    const requestId = current.current
    current.current = null
    setRun({ kind: 'idle' })
    if (requestId) {
      cancelAvatarRequest(requestId)
    }
  }

  return {
    agents,
    agent,
    selectAgent,
    run,
    result,
    generate,
    cancel,
    clearError: () => setRun((now) => (now.kind === 'error' ? { kind: 'idle' } : now)),
    handOff: (target) => handOffAvatarRequest(current.current, target),
    reset: () => {
      if (current.current) {
        releaseAvatarRequest(current.current)
        current.current = null
      }
      setRun({ kind: 'idle' })
      setResult(null)
    },
    choiceKey: draftKey
  }
}
