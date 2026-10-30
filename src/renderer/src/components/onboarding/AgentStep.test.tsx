import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveAgentLaunchRoute } from '@/lib/agent-launch-routing'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AgentStep } from './AgentStep'

function render(
  agentSurface: 'chat' | 'terminal',
  detected: TuiAgent[],
  selectedAgent: TuiAgent | null = detected[0] ?? null,
  chatDetected = detected.filter((agent) => agent === 'claude' || agent === 'codex'),
  nativeChatProviders?: GlobalSettings['nativeChatProviders']
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AgentStep
        agentSurface={agentSurface}
        selectedAgent={selectedAgent}
        onSelect={() => {}}
        detectedSet={new Set(detected)}
        isDetecting={false}
        chatAgents={['claude', 'codex']}
        chatDetected={chatDetected}
        nativeChatProviders={nativeChatProviders}
      />
    </TooltipProvider>
  )
}

const TERMINAL_SECTION = 'Available as terminal agents'

/** Which Chat UI mode section a tile sits in. */
function section(html: string, label: string): 'chat' | 'terminal' {
  const at = html.indexOf(`title="${label}"`)
  const terminalAt = html.indexOf(TERMINAL_SECTION)
  return terminalAt !== -1 && at > terminalAt ? 'terminal' : 'chat'
}

function tile(html: string, label: string): string {
  const start = html.indexOf(`title="${label}"`)
  return html.slice(start, html.indexOf('</button>', start))
}

describe('AgentStep agent surfaces', () => {
  it('groups detected agents by where they open in Chat UI mode', () => {
    const html = render('chat', ['claude', 'aider'])

    expect(html).toContain('Chat UI agents')
    expect(section(html, 'Claude')).toBe('chat')
    expect(section(html, 'Aider')).toBe('terminal')
    expect(html).toContain('Agents open in')
  })

  it('suggests Terminal when the picked agent has no Chat UI', () => {
    const html = render('chat', ['claude', 'aider'], 'aider')

    expect(html).toContain('opens in a terminal')
    expect(html).toContain('Use Terminal instead')
  })

  it('lists chat agents to install when none are detected in Chat UI mode', () => {
    const html = render('chat', ['aider'])

    expect(html).toContain('None of your agents work in Chat UI')
    expect(html).toContain('Works in Chat UI')
    expect(section(html, 'Codex')).toBe('chat')
    expect(section(html, 'Aider')).toBe('terminal')
    // One warning at a time: the per-agent note stays hidden.
    expect(html).not.toContain('Aider</span> opens in a terminal')
  })

  it('only labels chat-capable agents in Terminal mode', () => {
    const html = render('terminal', ['claude', 'aider'])

    expect(tile(html, 'Claude')).toContain('Chat available')
    expect(tile(html, 'Aider')).not.toContain('Terminal')
    expect(html).toContain('Turn on now')
  })

  it('uses native Chat installations even when the terminal inventory belongs to WSL', () => {
    const html = render('chat', ['aider'], 'claude', ['claude'])

    expect(section(html, 'Claude')).toBe('chat')
    expect(html).not.toContain('None of your agents work in Chat UI')
    expect(html).not.toContain('isn&#x27;t on your PATH')
    expect(html).not.toContain('Install instructions')

    const terminal = render('terminal', ['aider'], 'claude', ['claude'])
    expect(terminal).toContain('Install instructions')
  })

  it('labels a saved CLI preference with the destination the launch router will use', () => {
    const nativeChatProviders = { claude: false }
    const html = render('chat', ['claude'], 'claude', ['claude'], nativeChatProviders)
    const route = resolveAgentLaunchRoute({
      agent: 'claude',
      settings: { experimentalNativeChat: true, nativeChatProviders },
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    })

    expect(route).toBe('terminal-tui')
    expect(section(html, 'Claude')).toBe('terminal')
    expect(html).toContain('opens in a terminal')
    expect(html).not.toContain('None of your agents work in Chat UI')
  })

  it('keeps missing WSL installation guidance for a native-only provider set to Terminal', () => {
    const html = render('chat', ['aider'], 'claude', ['claude'], { claude: false })

    expect(html).toContain('Install instructions')
    expect(html).not.toContain('None of your agents work in Chat UI')
  })
})
