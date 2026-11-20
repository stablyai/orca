// Generating an avatar with a local image-capable agent; the run is canceled if the picker closes.
import { useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability,
  AvatarGenerationFailure,
  AvatarImageAgent,
  AvatarImageAgentStatus,
  GeneratedAvatarImage
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { describesRealPerson } from '../../../../shared/avatar-generation/avatar-generation-prompt'
import { pickAvatarAgent } from '../../../../shared/avatar-generation/avatar-generation-agent-choice'
import { avatarPngFromBlob } from './bot-avatar-intake'

export type AvatarGenerationRun =
  | { kind: 'idle' }
  | { kind: 'running'; agent: AvatarImageAgent }
  | { kind: 'error'; failure: AvatarGenerationFailure; agent?: AvatarImageAgent }

/** The last picture made: the square 512 px PNG an upload would save, and what it was asked for. */
export type GeneratedAvatar = { png: string; description: string }

function generationApi(): AvatarGenerationApi | null {
  // Desktop only: a paired web or phone client has no local agents to run.
  return isWebClientLocation() ? null : (window.api?.avatarGeneration ?? null)
}

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

export function useAvatarGeneration(onResult: (result: GeneratedAvatar) => void): {
  agents: AvatarImageAgentStatus[]
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
  const [agents, setAgents] = useState<AvatarImageAgentStatus[]>([])
  const remembered = useAppStore((store) => store.settings?.avatarGenerationAgent)
  const [chosen, setChosen] = useState<AvatarImageAgent | null>(null)
  const agent = pickAvatarAgent(agents, chosen ?? remembered)
  const [run, setRun] = useState<AvatarGenerationRun>({ kind: 'idle' })
  const [result, setResult] = useState<GeneratedAvatar | null>(null)
  const current = useRef<string | null>(null)
  // A result can land after the face moved; the picker decides then whether it applies.
  const latestOnResult = useRef(onResult)
  useEffect(() => {
    latestOnResult.current = onResult
  })

  const setStatus = (target: AvatarImageAgent, status: AvatarImageAgentStatus['status']): void =>
    setAgents((list) =>
      list.map((entry) => (entry.agent === target ? { agent: target, status } : entry))
    )

  useEffect(() => {
    const api = generationApi()
    if (!api) {
      return
    }
    let live = true
    void api.capability().then(
      (found: AvatarGenerationCapability | undefined) => {
        // A bridge without this namespace (web fallbacks) answers undefined: keep Generate hidden.
        if (live && Array.isArray(found?.agents)) {
          setAgents(found.agents)
        }
      },
      () => {}
    )
    return () => {
      live = false
      // An open run costs the user's usage; nobody is left to see it.
      if (current.current) {
        void api.cancel({ requestId: current.current }).catch(() => {})
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
    const api = generationApi()
    const text = description.trim()
    if (!api || !text || !agent || run.kind === 'running') {
      return
    }
    if (describesRealPerson(text)) {
      setRun({ kind: 'error', failure: 'real-person' })
      return
    }
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
            setStatus(agent, 'signed-out')
          }
          fail(outcome.error)
          return
        }
        // A run that worked proves the agent ready, whatever an older probe said.
        setStatus(outcome.agent, 'ready')
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
      void generationApi()
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
