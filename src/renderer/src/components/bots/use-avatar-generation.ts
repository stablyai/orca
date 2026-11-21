// Generating an avatar with a local image-capable agent; the run is canceled if the picker closes.
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  AvatarGenerationFailure,
  AvatarImageAgent,
  AvatarImageAgentStatus,
  GeneratedAvatarImage
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { describesRealPerson } from '../../../../shared/avatar-generation/avatar-generation-prompt'
import { pickAvatarAgent } from '../../../../shared/avatar-generation/avatar-generation-agent-choice'
import { avatarPngFromBlob } from './bot-avatar-intake'
import { rememberGeneratedPicture } from './generated-avatar-descriptions'
import {
  avatarGenerationApi,
  refreshAvatarCapability,
  setAvatarAgentStatus,
  useAvatarCapability
} from './avatar-generation-capability-store'

const NO_AGENTS: readonly AvatarImageAgentStatus[] = []

export type AvatarGenerationRun =
  | { kind: 'idle' }
  | { kind: 'running'; agent: AvatarImageAgent }
  | { kind: 'error'; failure: AvatarGenerationFailure; agent?: AvatarImageAgent }

/** The last picture made: the square 512 px PNG an upload would save, and what it was asked for. */
export type GeneratedAvatar = { png: string; description: string }

function rememberAgent(agent: AvatarImageAgent): void {
  const { settings, updateSettings } = useAppStore.getState()
  if (settings && settings.avatarGenerationAgent !== agent) {
    void updateSettings({ avatarGenerationAgent: agent })
  }
}

function imageBlob(image: GeneratedAvatarImage): Blob {
  const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: image.mimeType })
}

/** `onStart` runs once a run is accepted (after the description is checked), before the agent is asked. */
export function useAvatarGeneration(
  onResult: (result: GeneratedAvatar) => void,
  onStart?: () => void
): {
  agents: readonly AvatarImageAgentStatus[]
  /** null while no capable agent was found. */
  agent: AvatarImageAgent | null
  selectAgent: (agent: AvatarImageAgent) => void
  run: AvatarGenerationRun
  /** Kept while the picker is open, through later runs that fail or are canceled. */
  result: GeneratedAvatar | null
  generate: (description: string) => void
  cancel: () => void
  clearError: () => void
} {
  const agents = useAvatarCapability() ?? NO_AGENTS
  const remembered = useAppStore((store) => store.settings?.avatarGenerationAgent)
  const [chosen, setChosen] = useState<AvatarImageAgent | null>(null)
  const agent = pickAvatarAgent(agents, chosen ?? remembered)
  const [run, setRun] = useState<AvatarGenerationRun>({ kind: 'idle' })
  const [result, setResult] = useState<GeneratedAvatar | null>(null)
  const current = useRef<string | null>(null)
  // A result can land after the face moved; the picker decides then whether it applies.
  const latestOnResult = useRef(onResult)
  const latestOnStart = useRef(onStart)
  useEffect(() => {
    latestOnResult.current = onResult
    latestOnStart.current = onStart
  })

  useEffect(() => {
    // Picks up agents installed or signed in since the last check, for the next open's layout.
    refreshAvatarCapability()
    return () => {
      // An open run costs the user's usage; nobody is left to see it.
      if (current.current) {
        void avatarGenerationApi()
          ?.cancel({ requestId: current.current })
          .catch(() => {})
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
    const api = avatarGenerationApi()
    const text = description.trim()
    if (!api || !text || !agent || run.kind === 'running') {
      return
    }
    if (describesRealPerson(text)) {
      setRun({ kind: 'error', failure: 'real-person' })
      return
    }
    latestOnStart.current?.()
    const requestId = createNonSecureContextUuid()
    current.current = requestId
    rememberAgent(agent)
    setRun({ kind: 'running', agent })
    const fail = (failure: AvatarGenerationFailure): void => {
      if (current.current === requestId) {
        current.current = null
        setRun({ kind: 'error', failure, agent })
      }
    }
    void api.generate({ requestId, description: text, agent }).then(
      async (outcome) => {
        if (current.current !== requestId) {
          return
        }
        if (!outcome.ok) {
          if (outcome.error === 'canceled') {
            current.current = null
            setRun({ kind: 'idle' })
            return
          }
          if (outcome.error === 'signed-out') {
            setAvatarAgentStatus(agent, 'signed-out')
          }
          fail(outcome.error)
          return
        }
        // A run that worked proves the agent ready, whatever an older probe said.
        setAvatarAgentStatus(outcome.agent, 'ready')
        // The same square crop an upload gets, so what shows is exactly what saves.
        const png = await avatarPngFromBlob(imageBlob(outcome.image)).catch(() => null)
        if (current.current !== requestId) {
          return
        }
        if (!png) {
          fail('no-image')
          return
        }
        current.current = null
        const made = { png, description: text }
        rememberGeneratedPicture(png, text)
        setResult(made)
        setRun({ kind: 'idle' })
        latestOnResult.current(made)
      },
      () => fail('failed')
    )
  }

  const cancel = (): void => {
    const requestId = current.current
    current.current = null
    setRun({ kind: 'idle' })
    if (requestId) {
      void avatarGenerationApi()
        ?.cancel({ requestId })
        .catch(() => {})
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
    clearError: () => setRun((now) => (now.kind === 'error' ? { kind: 'idle' } : now))
  }
}
