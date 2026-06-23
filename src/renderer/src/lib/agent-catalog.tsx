import type React from 'react'
import { ClaudeIcon, DroidIcon, OpenAIIcon } from '@/components/status-bar/icons'
import openClaudeLogoUrl from '../../../../resources/openclaude-logo.png?url'
import type { TuiAgent } from '../../../shared/types'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  AgentLetterIcon,
  AiderIcon,
  CopilotIcon,
  KiloIcon,
  OmpIcon,
  PiIcon
} from './agent-icon-glyphs'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type AgentCatalogEntry = {
  id: TuiAgent
  label: string
  /** Default CLI binary name used for PATH detection. */
  cmd: string
  /** Direct or bundled image URL for agents whose project identity is not represented by a favicon service. */
  iconUrl?: string
  /** Domain for Google's favicon service — used for agents without an SVG icon. */
  faviconDomain?: string
  /** Homepage/install docs URL, sourced from the README agent badge list. */
  homepageUrl: string
}

function getCatalogPlatform(): NodeJS.Platform {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent) {
    return 'linux'
  }
  return typeof process === 'undefined' ? 'linux' : process.platform
}

export const getAgentCatalog = createLocalizedCatalog((): AgentCatalogEntry[] => [
  {
    id: 'claude',
    label: translate('auto.lib.agent.catalog.0708ed89f1', 'Claude'),
    cmd: 'claude',
    homepageUrl: 'https://docs.anthropic.com/claude/docs/claude-code'
  },
  {
    id: 'claude-agent-teams',
    label: translate('auto.lib.agent.catalog.bf53f09bf8', 'Claude Agent Teams'),
    cmd: getTuiAgentLaunchCommand(TUI_AGENT_CONFIG['claude-agent-teams'], getCatalogPlatform()),
    homepageUrl: 'https://code.claude.com/docs/agent-teams'
  },
  {
    id: 'openclaude',
    label: translate('auto.lib.agent.catalog.a5fc0cb622', 'OpenClaude'),
    cmd: 'openclaude',
    // Why: OpenClaude's published favicon has a padded 500px canvas; Orca
    // uses a cropped derivative of that official asset so 12px tab icons stay legible.
    iconUrl: openClaudeLogoUrl,
    homepageUrl: 'https://openclaude.gitlawb.com/'
  },
  {
    id: 'codex',
    label: translate('auto.lib.agent.catalog.760bc6883d', 'Codex'),
    cmd: 'codex',
    homepageUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'grok',
    label: translate('auto.lib.agent.catalog.0baad2d5d2', 'Grok'),
    cmd: 'grok',
    faviconDomain: 'x.ai',
    homepageUrl: 'https://x.ai/cli'
  },
  {
    id: 'copilot',
    label: translate('auto.lib.agent.catalog.706b0fe68b', 'GitHub Copilot'),
    cmd: 'copilot',
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  {
    id: 'opencode',
    label: translate('auto.lib.agent.catalog.e7a4ca5103', 'OpenCode'),
    cmd: 'opencode',
    faviconDomain: 'opencode.ai',
    homepageUrl: 'https://opencode.ai/docs/cli/'
  },
  {
    id: 'ante',
    label: translate('auto.lib.agent.catalog.da41abbdd4', 'Ante'),
    cmd: 'ante',
    faviconDomain: 'antigma.ai',
    homepageUrl: 'https://github.com/AntigmaLabs/ante-preview'
  },
  {
    id: 'pi',
    label: translate('auto.lib.agent.catalog.302934c5d9', 'Pi'),
    cmd: 'pi',
    homepageUrl: 'https://pi.dev'
  },
  {
    id: 'omp',
    label: translate('auto.lib.agent.catalog.09973b4d84', 'OMP'),
    cmd: 'omp',
    faviconDomain: 'omp.sh',
    homepageUrl: 'https://omp.sh'
  },
  {
    id: 'gemini',
    label: translate('auto.lib.agent.catalog.12e6baa4f7', 'Gemini'),
    cmd: 'gemini',
    faviconDomain: 'gemini.google.com',
    homepageUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'antigravity',
    label: translate('auto.lib.agent.catalog.691dd11789', 'Antigravity'),
    cmd: 'agy',
    faviconDomain: 'antigravity.google',
    homepageUrl: 'https://antigravity.google/docs/cli-overview'
  },
  {
    id: 'aider',
    label: translate('auto.lib.agent.catalog.b32627f09b', 'Aider'),
    cmd: 'aider',
    homepageUrl: 'https://aider.chat/docs/'
  },
  {
    id: 'goose',
    label: translate('auto.lib.agent.catalog.8da11d876c', 'Goose'),
    cmd: 'goose',
    faviconDomain: 'goose-docs.ai',
    homepageUrl: 'https://block.github.io/goose/docs/quickstart/'
  },
  {
    id: 'amp',
    label: translate('auto.lib.agent.catalog.c73c573939', 'Amp'),
    cmd: 'amp',
    faviconDomain: 'ampcode.com',
    homepageUrl: 'https://ampcode.com/manual#install'
  },
  {
    id: 'kilo',
    label: translate('auto.lib.agent.catalog.918ba4ffed', 'Kilocode'),
    cmd: 'kilo',
    homepageUrl: 'https://kilo.ai/docs/cli'
  },
  {
    id: 'kiro',
    label: translate('auto.lib.agent.catalog.e0247254f2', 'Kiro'),
    // Why: the Kiro installer (https://cli.kiro.dev/install) ships a binary
    // named `kiro-cli`, not `kiro`. Match TUI_AGENT_CONFIG.kiro.detectCmd so
    // the settings pane's "default command" hint aligns with what Orca
    // actually looks for on PATH.
    cmd: 'kiro-cli',
    faviconDomain: 'kiro.dev',
    homepageUrl: 'https://kiro.dev/docs/cli/'
  },
  {
    id: 'crush',
    label: translate('auto.lib.agent.catalog.9477377a2a', 'Charm'),
    cmd: 'crush',
    faviconDomain: 'charm.sh',
    homepageUrl: 'https://github.com/charmbracelet/crush'
  },
  {
    id: 'aug',
    label: translate('auto.lib.agent.catalog.5e8eff11b3', 'Auggie'),
    cmd: 'auggie',
    faviconDomain: 'augmentcode.com',
    homepageUrl: 'https://docs.augmentcode.com/cli/overview'
  },
  {
    id: 'autohand',
    label: translate('auto.lib.agent.catalog.1f8a19e9ad', 'Autohand Code'),
    cmd: 'autohand',
    faviconDomain: 'autohand.ai',
    homepageUrl: 'https://github.com/autohandai/code-cli'
  },
  {
    id: 'cline',
    label: translate('auto.lib.agent.catalog.cbaf0c2e0b', 'Cline'),
    cmd: 'cline',
    faviconDomain: 'cline.bot',
    homepageUrl: 'https://docs.cline.bot/cline-cli/overview'
  },
  {
    id: 'codebuff',
    label: translate('auto.lib.agent.catalog.4238b771b5', 'Codebuff'),
    cmd: 'codebuff',
    faviconDomain: 'codebuff.com',
    homepageUrl: 'https://www.codebuff.com/docs/help/quick-start'
  },
  {
    id: 'command-code',
    label: translate('auto.lib.agent.catalog.6f8056a565', 'Command Code'),
    // Why: `npm i -g command-code` installs both `command-code` and the
    // shorter alias `cmd`. Show the full name in the settings hint so it
    // matches TUI_AGENT_CONFIG['command-code'].detectCmd and avoids any
    // suggestion that Orca is looking for Windows' built-in `cmd.exe`.
    cmd: 'command-code',
    faviconDomain: 'commandcode.ai',
    homepageUrl: 'https://commandcode.ai/docs/quickstart'
  },
  {
    id: 'continue',
    label: translate('auto.lib.agent.catalog.9e2a9bb87b', 'Continue'),
    // Why: Continue's terminal agent installs as `cn`; `continue` resolves to
    // a shell builtin in common shells and is not a reliable executable hint.
    cmd: 'cn',
    faviconDomain: 'continue.dev',
    homepageUrl: 'https://docs.continue.dev/guides/cli'
  },
  {
    id: 'cursor',
    label: translate('auto.lib.agent.catalog.667c104cff', 'Cursor'),
    cmd: 'cursor-agent',
    faviconDomain: 'cursor.com',
    homepageUrl: 'https://cursor.com/cli'
  },
  {
    id: 'droid',
    label: translate('auto.lib.agent.catalog.739a930554', 'Droid'),
    cmd: 'droid',
    homepageUrl: 'https://docs.factory.ai/cli/getting-started/quickstart'
  },
  {
    id: 'kimi',
    label: translate('auto.lib.agent.catalog.28810273af', 'Kimi'),
    cmd: 'kimi',
    faviconDomain: 'moonshot.cn',
    homepageUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html'
  },
  {
    id: 'mistral-vibe',
    label: translate('auto.lib.agent.catalog.ca73055bd0', 'Mistral Vibe'),
    // Why: `uv tool install mistral-vibe` exposes the interactive CLI as
    // `vibe`; the package name is not the executable users put on PATH.
    cmd: 'vibe',
    faviconDomain: 'mistral.ai',
    homepageUrl: 'https://github.com/mistralai/mistral-vibe'
  },
  {
    id: 'qwen-code',
    label: translate('auto.lib.agent.catalog.bee242fe3d', 'Qwen Code'),
    cmd: 'qwen-code',
    faviconDomain: 'qwenlm.github.io',
    homepageUrl: 'https://github.com/QwenLM/qwen-code'
  },
  {
    id: 'rovo',
    label: translate('auto.lib.agent.catalog.4e63c7b956', 'Rovo Dev'),
    cmd: 'rovo',
    faviconDomain: 'atlassian.com',
    homepageUrl:
      'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/'
  },
  {
    id: 'hermes',
    label: translate('auto.lib.agent.catalog.8a9ba743cc', 'Hermes'),
    cmd: 'hermes',
    faviconDomain: 'nousresearch.com',
    homepageUrl: 'https://hermes-agent.nousresearch.com/docs/'
  },
  {
    id: 'devin',
    label: translate('auto.lib.agent.catalog.fc80296033', 'Devin'),
    cmd: 'devin',
    faviconDomain: 'devin.ai',
    homepageUrl: 'https://devin.ai/cli'
  },
  {
    id: 'openclaw',
    label: translate('auto.lib.agent.catalog.5dff448636', 'OpenClaw'),
    cmd: 'openclaw',
    faviconDomain: 'openclaw.ai',
    homepageUrl: 'https://github.com/openclaw/openclaw'
  }
])

// Why: tests and a few legacy call sites still import a catalog snapshot.
export const AGENT_CATALOG: AgentCatalogEntry[] = getAgentCatalog()

export function getAgentLabel(agent: TuiAgent): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}

export function AgentIcon({
  agent,
  size = 14
}: {
  agent: TuiAgent | null | undefined
  size?: number
}): React.JSX.Element {
  // Why: render a neutral question-mark glyph when the agent identity is not
  // yet known. Before, the caller coerced null → 'claude', which caused Codex
  // panes to briefly show the Claude icon until the first hook callback
  // arrived.
  if (!agent) {
    return <AgentLetterIcon letter="?" size={size} />
  }
  if (agent === 'claude' || agent === 'claude-agent-teams') {
    return <ClaudeIcon size={size} />
  }
  if (agent === 'codex') {
    return <OpenAIIcon size={size} />
  }
  if (agent === 'droid') {
    return <DroidIcon size={size} />
  }
  if (agent === 'pi') {
    return <PiIcon size={size} />
  }
  if (agent === 'omp') {
    return <OmpIcon size={size} />
  }
  if (agent === 'aider') {
    return <AiderIcon size={size} />
  }
  if (agent === 'kilo') {
    return <KiloIcon size={size} />
  }
  if (agent === 'copilot') {
    return <CopilotIcon size={size} />
  }
  const catalogEntry = getAgentCatalog().find((a) => a.id === agent)
  if (catalogEntry?.iconUrl) {
    return (
      <img
        src={catalogEntry.iconUrl}
        width={size}
        height={size}
        alt=""
        style={{ borderRadius: 2 }}
      />
    )
  }
  if (catalogEntry?.faviconDomain) {
    // Why: agents without a published SVG icon use their site favicon via
    // Google's favicon service — same source the README uses for the agent badge list.
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${catalogEntry.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  const label = catalogEntry?.label ?? agent
  return <AgentLetterIcon letter={label.charAt(0).toUpperCase()} size={size} />
}
