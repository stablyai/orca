import type React from 'react'
import { ClaudeIcon, DroidIcon, OpenAIIcon } from '@/components/status-bar/icons'
import openClaudeLogoUrl from '../../../../resources/openclaude-logo.png?url'
import type { TuiAgent } from '../../../shared/types'
import {
  AgentLetterIcon,
  AiderIcon,
  CopilotIcon,
  KiloIcon,
  OmpIcon,
  PiIcon
} from './agent-icon-glyphs'

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

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: 'claude',
    label: 'Claude',
    cmd: 'claude',
    homepageUrl: 'https://docs.anthropic.com/claude/docs/claude-code'
  },
  {
    id: 'openclaude',
    label: 'OpenClaude',
    cmd: 'openclaude',
    // Why: OpenClaude's published favicon has a padded 500px canvas; Orca
    // uses a cropped derivative of that official asset so 12px tab icons stay legible.
    iconUrl: openClaudeLogoUrl,
    homepageUrl: 'https://openclaude.gitlawb.com/'
  },
  {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    homepageUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'grok',
    label: 'Grok',
    cmd: 'grok',
    faviconDomain: 'x.ai',
    homepageUrl: 'https://x.ai/cli'
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    cmd: 'copilot',
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    faviconDomain: 'opencode.ai',
    homepageUrl: 'https://opencode.ai/docs/cli/'
  },
  {
    id: 'pi',
    label: 'Pi',
    cmd: 'pi',
    homepageUrl: 'https://pi.dev'
  },
  {
    id: 'omp',
    label: 'OMP',
    cmd: 'omp',
    faviconDomain: 'omp.sh',
    homepageUrl: 'https://omp.sh'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    cmd: 'gemini',
    faviconDomain: 'gemini.google.com',
    homepageUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    cmd: 'agy',
    faviconDomain: 'antigravity.google',
    homepageUrl: 'https://antigravity.google/docs/cli-overview'
  },
  {
    id: 'aider',
    label: 'Aider',
    cmd: 'aider',
    homepageUrl: 'https://aider.chat/docs/'
  },
  {
    id: 'goose',
    label: 'Goose',
    cmd: 'goose',
    faviconDomain: 'goose-docs.ai',
    homepageUrl: 'https://block.github.io/goose/docs/quickstart/'
  },
  {
    id: 'amp',
    label: 'Amp',
    cmd: 'amp',
    faviconDomain: 'ampcode.com',
    homepageUrl: 'https://ampcode.com/manual#install'
  },
  {
    id: 'kilo',
    label: 'Kilocode',
    cmd: 'kilo',
    homepageUrl: 'https://kilo.ai/docs/cli'
  },
  {
    id: 'kiro',
    label: 'Kiro',
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
    label: 'Charm',
    cmd: 'crush',
    faviconDomain: 'charm.sh',
    homepageUrl: 'https://github.com/charmbracelet/crush'
  },
  {
    id: 'aug',
    label: 'Auggie',
    cmd: 'auggie',
    faviconDomain: 'augmentcode.com',
    homepageUrl: 'https://docs.augmentcode.com/cli/overview'
  },
  {
    id: 'autohand',
    label: 'Autohand Code',
    cmd: 'autohand',
    faviconDomain: 'autohand.ai',
    homepageUrl: 'https://github.com/autohandai/code-cli'
  },
  {
    id: 'cline',
    label: 'Cline',
    cmd: 'cline',
    faviconDomain: 'cline.bot',
    homepageUrl: 'https://docs.cline.bot/cline-cli/overview'
  },
  {
    id: 'codebuff',
    label: 'Codebuff',
    cmd: 'codebuff',
    faviconDomain: 'codebuff.com',
    homepageUrl: 'https://www.codebuff.com/docs/help/quick-start'
  },
  {
    id: 'command-code',
    label: 'Command Code',
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
    label: 'Continue',
    cmd: 'continue',
    faviconDomain: 'continue.dev',
    homepageUrl: 'https://docs.continue.dev/guides/cli'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    faviconDomain: 'cursor.com',
    homepageUrl: 'https://cursor.com/cli'
  },
  {
    id: 'droid',
    label: 'Droid',
    cmd: 'droid',
    homepageUrl: 'https://docs.factory.ai/cli/getting-started/quickstart'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    cmd: 'kimi',
    faviconDomain: 'moonshot.cn',
    homepageUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html'
  },
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    // Why: `uv tool install mistral-vibe` exposes the interactive CLI as
    // `vibe`; the package name is not the executable users put on PATH.
    cmd: 'vibe',
    faviconDomain: 'mistral.ai',
    homepageUrl: 'https://github.com/mistralai/mistral-vibe'
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    cmd: 'qwen-code',
    faviconDomain: 'qwenlm.github.io',
    homepageUrl: 'https://github.com/QwenLM/qwen-code'
  },
  {
    id: 'rovo',
    label: 'Rovo Dev',
    cmd: 'rovo',
    faviconDomain: 'atlassian.com',
    homepageUrl:
      'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/'
  },
  {
    id: 'hermes',
    label: 'Hermes',
    cmd: 'hermes',
    faviconDomain: 'nousresearch.com',
    homepageUrl: 'https://hermes-agent.nousresearch.com/docs/'
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    cmd: 'openclaw',
    faviconDomain: 'openclaw.ai',
    homepageUrl: 'https://github.com/openclaw/openclaw'
  }
]

export function getAgentLabel(agent: TuiAgent): string {
  return AGENT_CATALOG.find((entry) => entry.id === agent)?.label ?? agent
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
  if (agent === 'claude') {
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
  const catalogEntry = AGENT_CATALOG.find((a) => a.id === agent)
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
