import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Trans } from 'react-i18next'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import { i18n, translate } from '@/i18n/i18n'
import { openAppHttpLink } from '@/lib/app-http-link-open'
import { useScrollEdgeFades } from '@/lib/use-scroll-edge-fades'
import { cn } from '@/lib/utils'
import type { AgentSurface } from './use-onboarding-flow-types'
import { AgentPickerButton, AgentSectionHeader } from './AgentPickerButton'
import { YoloPermissionsControl } from './YoloPermissionsControl'
import {
  AgentSurfaceModeRow,
  ChatModeTerminalTip,
  NoChatAgentsNotice,
  TerminalFitNotice,
  TerminalModeChatTip,
  chatAvailableDetail
} from './AgentStepSurfaceSections'

const NO_CHAT_AGENTS: readonly TuiAgent[] = []

type AgentStepProps = {
  /** Omitted: a plain default-agent picker without Chat UI labels. */
  agentSurface?: AgentSurface
  onAgentSurfaceChange?: (surface: AgentSurface) => void
  /** Pick Chat UI or Terminal on this page, where no earlier page chose it. */
  agentSurfaceSwitchable?: boolean
  selectedAgent: TuiAgent | null
  // Record whether the click came from the details disclosure for onboarding_agent_picked telemetry.
  onSelect: (agent: TuiAgent, fromCollapsedSection: boolean) => void
  detectedSet: Set<TuiAgent>
  isDetecting: boolean
  chatAgents?: readonly TuiAgent[]
  chatDetected?: readonly TuiAgent[] | null
  nativeChatProviders?: GlobalSettings['nativeChatProviders']
  yoloPermissions?: boolean
  onYoloPermissionsChange?: (enabled: boolean) => void
}

export function AgentStep({
  agentSurface,
  onAgentSurfaceChange,
  agentSurfaceSwitchable = false,
  selectedAgent,
  onSelect,
  detectedSet,
  isDetecting,
  chatAgents = NO_CHAT_AGENTS,
  chatDetected = null,
  nativeChatProviders,
  yoloPermissions = true,
  onYoloPermissionsChange
}: AgentStepProps) {
  const agentCatalog = getAgentCatalog()
  const gridFades = useScrollEdgeFades<HTMLElement>()
  const chatMode = agentSurface === 'chat'
  // Chat runs only on native installs; an agent found only in WSL opens in a terminal.
  const opensAsChat = (id: TuiAgent): boolean =>
    chatAgents.includes(id) &&
    isNativeChatDefaultFor({ experimentalNativeChat: true, nativeChatProviders }, id) &&
    (!detectedSet.has(id) || chatDetected === null || chatDetected.includes(id))
  const availableDetected = new Set([
    ...detectedSet,
    ...(chatMode ? (chatDetected ?? []).filter(opensAsChat) : [])
  ])
  const detected = agentCatalog.filter((agent) => availableDetected.has(agent.id))
  const hasDetected = detected.length > 0
  const anyChatDetected =
    chatDetected === null
      ? detected.some((agent) => chatAgents.includes(agent.id))
      : chatDetected.length > 0
  const noChatAgents = chatMode && !isDetecting && chatDetected !== null && !anyChatDetected
  // Without a chat-capable agent installed, Chat UI users see which ones to install.
  const worksInChat = noChatAgents
    ? agentCatalog.filter(
        (agent) => chatAgents.includes(agent.id) && !availableDetected.has(agent.id)
      )
    : []
  // Chat UI mode groups agents by where they open instead of labeling every tile.
  const chatSection = chatMode
    ? noChatAgents
      ? worksInChat
      : detected.filter((agent) => opensAsChat(agent.id))
    : []
  const terminalSection = chatMode ? detected.filter((agent) => !opensAsChat(agent.id)) : []
  const primary = chatMode ? [] : hasDetected ? detected : agentCatalog.slice(0, 6)
  const listed = new Set([...primary, ...chatSection, ...terminalSection].map((agent) => agent.id))
  const fallbackRest = agentCatalog.filter((agent) => !listed.has(agent.id))
  // Placeholders until detection settles, so labels and the auto-pick don't flip under the pointer.
  const showSkeleton = agentSurface !== undefined && isDetecting && !hasDetected
  const selectedEntry =
    selectedAgent &&
    !availableDetected.has(selectedAgent) &&
    (!chatMode || !chatAgents.includes(selectedAgent) || chatDetected !== null)
      ? agentCatalog.find((a) => a.id === selectedAgent)
      : undefined
  const selectedTerminalOnly =
    chatMode && anyChatDetected && selectedAgent !== null && availableDetected.has(selectedAgent)
      ? agentCatalog.find((a) => a.id === selectedAgent && !opensAsChat(a.id))
      : undefined
  const selectedEntryIsCollapsed =
    selectedAgent != null && fallbackRest.some((a) => a.id === selectedAgent)
  // Auto-open when selection enters the fallback bucket; never force-close a disclosure the user can toggle.
  const [openState, setOpenState] = useState(selectedEntryIsCollapsed)
  const [previousSelectedEntryIsCollapsed, setPreviousSelectedEntryIsCollapsed] =
    useState(selectedEntryIsCollapsed)
  if (selectedEntryIsCollapsed !== previousSelectedEntryIsCollapsed) {
    setPreviousSelectedEntryIsCollapsed(selectedEntryIsCollapsed)
    if (selectedEntryIsCollapsed && !openState) {
      setOpenState(true)
    }
  }
  const fallbackRestLabel = openState
    ? translate('auto.components.onboarding.AgentStep.hideAgents', 'Hide agents')
    : translate(
        'auto.components.onboarding.AgentStep.showMoreAgents',
        'Show {{count}} more agents →',
        { count: fallbackRest.length, defaultValue_one: 'Show {{count}} more agent →' }
      )
  const useTerminal = (): void => onAgentSurfaceChange?.('terminal')
  const renderTile = (agent: AgentCatalogEntry, fromCollapsedSection: boolean) => (
    <AgentPickerButton
      key={agent.id}
      agent={agent}
      selected={selectedAgent === agent.id}
      detail={agentSurface === 'terminal' ? chatAvailableDetail(opensAsChat(agent.id)) : undefined}
      onClick={() => onSelect(agent.id, fromCollapsedSection)}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {agentSurface && (
        <AgentSurfaceModeRow
          surface={agentSurface}
          onChange={agentSurfaceSwitchable ? onAgentSurfaceChange : undefined}
        />
      )}
      {!hasDetected && !isDetecting && !chatMode && (
        <div className="shrink-0 rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.onboarding.AgentStep.1eee1c7bd8',
            'No agents detected on your PATH. Pick one to install later, or continue with a blank terminal.'
          )}
        </div>
      )}
      {noChatAgents && (
        <NoChatAgentsNotice
          anyDetected={hasDetected}
          chatAgentLabels={agentCatalog
            .filter((agent) => chatAgents.includes(agent.id))
            .map((agent) => agent.label)}
          onUseTerminal={useTerminal}
        />
      )}
      {selectedTerminalOnly && (
        <TerminalFitNotice agentLabel={selectedTerminalOnly.label} onUseTerminal={useTerminal} />
      )}
      {selectedEntry && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-status-warning-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            <Trans
              i18n={i18n}
              defaults={translate(
                'auto.components.onboarding.AgentStep.agentNotOnPath',
                "<agent>{{agent}}</agent> isn't on your PATH yet. Orca will set it as your default and you can install it any time.",
                { agent: selectedEntry.label }
              )}
              components={{ agent: <span className="font-medium text-foreground" /> }}
            />
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={(event) => openAppHttpLink(selectedEntry.homepageUrl, { event })}
          >
            {translate('auto.components.onboarding.AgentStep.9c163bb0e0', 'Install instructions')}
            <ExternalLink className="size-3" />
          </Button>
        </div>
      )}
      <section
        ref={gridFades.ref}
        data-agent-grid-scroll
        className={cn(
          'scrollbar-sleek min-h-0 space-y-5 overflow-y-auto pr-1',
          gridFades.className
        )}
      >
        {showSkeleton ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3" aria-busy="true">
            {[0, 1, 2].map((key) => (
              <div
                key={key}
                className="h-[54px] animate-pulse rounded-lg border border-border bg-muted/50"
              />
            ))}
          </div>
        ) : (
          <>
            {primary.length > 0 && (
              <div className="space-y-3">
                <AgentSectionHeader
                  label={
                    hasDetected
                      ? translate(
                          'auto.components.onboarding.AgentStep.d7b3ef168b',
                          'Detected on your system'
                        )
                      : translate(
                          'auto.components.onboarding.AgentStep.e6a369bd04',
                          'Popular agents'
                        )
                  }
                  count={primary.length}
                />
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                  {primary.map((agent) => renderTile(agent, false))}
                </div>
              </div>
            )}
            {chatSection.length > 0 && (
              <div className="space-y-3">
                <AgentSectionHeader
                  label={
                    noChatAgents
                      ? translate('components.onboarding.agentStep.worksInChat', 'Works in Chat UI')
                      : translate('components.onboarding.agentStep.chatAgents', 'Chat UI agents')
                  }
                  count={chatSection.length}
                />
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                  {chatSection.map((agent) => renderTile(agent, false))}
                </div>
              </div>
            )}
            {terminalSection.length > 0 && (
              <div className="space-y-3">
                <AgentSectionHeader
                  label={translate(
                    'components.onboarding.agentStep.terminalAgents',
                    'Available as terminal agents'
                  )}
                  hint={translate(
                    'components.onboarding.agentStep.terminalAgentsHint',
                    'No Chat UI support, so these fall back to a terminal.'
                  )}
                  count={terminalSection.length}
                />
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                  {terminalSection.map((agent) => renderTile(agent, false))}
                </div>
              </div>
            )}
            {fallbackRest.length > 0 && (
              <Collapsible open={openState} onOpenChange={setOpenState}>
                <CollapsibleTrigger className="cursor-pointer text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:mb-3">
                  {fallbackRestLabel}
                </CollapsibleTrigger>
                <CollapsibleContent className="collapsible-height-content">
                  <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
                    {fallbackRest.map((agent) => renderTile(agent, true))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </section>
      {agentSurface === 'chat' && <ChatModeTerminalTip />}
      {agentSurface === 'terminal' && !agentSurfaceSwitchable && (
        <TerminalModeChatTip onUseChat={() => onAgentSurfaceChange?.('chat')} />
      )}
      <YoloPermissionsControl
        yoloPermissions={yoloPermissions}
        onYoloPermissionsChange={onYoloPermissionsChange}
      />
    </div>
  )
}
