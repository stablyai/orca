import { useMemo } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { getNativeChatAgentProfile } from '../../../shared/native-chat/native-chat-agent-profiles'
import { isSkillInstallProviderId } from '../../../shared/skill-install-providers'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { isWebClientLocation } from '@/lib/web-client-location'
import { readHostStructuredAgents } from '@/runtime/host-structured-agents'
import { useAppStore } from '@/store'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'

const LOCAL_RUNTIME = { kind: 'local' } as const
const HOST_DISCOVERY = { runtime: 'host' } as const

/** Onboarding's chat choice runs on this computer, independently of the selected project's terminal runtime. */
export function useOnboardingSkillRuntime() {
  const project = useActiveProjectSkillRuntime()
  const selected = useAppStore((state) => state.settings?.defaultTuiAgent)
  const selectedAgent = selected && selected !== 'blank' ? selected : undefined
  const chatRequested = useAppStore((state) =>
    selectedAgent
      ? nativeChatPreferenceFor(state.settings, selectedAgent)
      : state.settings?.agentDefaultSurface === 'chat'
  )
  useHostStructuredAgentsVersion()
  const desktopChatRequested = chatRequested && !isWebClientLocation()
  const chatSupported =
    !selectedAgent || chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined).includes(selectedAgent)
  const waitingForChatCatalog =
    desktopChatRequested &&
    !chatSupported &&
    readHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, undefined) === undefined
  const chat = desktopChatRequested && (chatSupported || waitingForChatCatalog)
  const agent = chat ? selectedAgent : undefined
  const owner = agent ? (getNativeChatAgentProfile(agent)?.skillSourceOwner ?? agent) : undefined
  const target = useMemo<BundledSkillTarget | null>(
    () =>
      waitingForChatCatalog
        ? null
        : chat
          ? owner && isSkillInstallProviderId(owner)
            ? { kind: 'local', agent: owner }
            : null
          : project.bundledSkillTarget,
    [chat, owner, project.bundledSkillTarget, waitingForChatCatalog]
  )
  const runtimeTarget: RuntimeClientTarget | null = chat
    ? LOCAL_RUNTIME
    : project.discoveryRuntimeTarget
  const discoveryTarget: SkillDiscoveryTarget | undefined = chat
    ? HOST_DISCOVERY
    : project.discoveryTarget
  return {
    ...project,
    ...(chat
      ? {
          projectRuntime: undefined,
          agentRuntime: undefined,
          terminalShellOverride: undefined,
          installDisabledReason: null
        }
      : {}),
    bundledSkillTarget: target,
    discoveryTarget,
    discoveryRuntimeTarget: runtimeTarget,
    agent,
    enabled: !chat || target !== null,
    setupKey: `${chat ? 'chat' : 'terminal'}:${target ? bundledSkillTargetKey(target) : JSON.stringify(discoveryTarget)}:${agent ?? ''}`
  }
}
