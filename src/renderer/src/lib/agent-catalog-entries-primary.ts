import { createReasonixAgentCatalogEntry } from './reasonix-agent-catalog-entry'
import { getCatalogPlatform } from './agent-catalog-platform'
import openClaudeLogoUrl from '../../../../resources/openclaude-logo.png?url'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from './agent-catalog'

/** The agents Orca drives first-party. Split from the community tail so adding an agent
 *  does not push either module past its line budget; the two are concatenated in order
 *  by `buildAgentCatalogEntries`. */
export function primaryAgentCatalogEntries(): AgentCatalogEntry[] {
  return [
    {
      id: 'claude',
      label: translate('auto.lib.agent.catalog.0708ed89f1', 'Claude'),
      cmd: 'claude',
      homepageUrl: 'https://code.claude.com/docs'
    },
    {
      id: 'claude-agent-teams',
      label: translate('auto.lib.agent.catalog.bf53f09bf8', 'Claude Agent Teams'),
      cmd: getTuiAgentLaunchCommand(TUI_AGENT_CONFIG['claude-agent-teams'], getCatalogPlatform()),
      homepageUrl: 'https://code.claude.com/docs/en/agent-teams'
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
      id: 'opencode2',
      label: translate('auto.lib.agent.catalog.opencode2_label', 'OpenCode 2'),
      cmd: 'opencode2',
      homepageUrl: 'https://opencode.ai/v2/docs/'
    },
    {
      id: 'opencode',
      label: translate('auto.lib.agent.catalog.e7a4ca5103', 'OpenCode'),
      cmd: 'opencode',
      homepageUrl: 'https://opencode.ai/docs/cli/'
    },
    {
      id: 'mimo-code',
      label: translate('auto.lib.agent.catalog.mimo_code_label', 'MiMo Code'),
      cmd: 'mimo',
      faviconDomain: 'mimo.xiaomi.com',
      homepageUrl: 'https://mimo.xiaomi.com/coder'
    },
    {
      id: 'ante',
      label: translate('auto.lib.agent.catalog.da41abbdd4', 'Ante'),
      cmd: 'ante',
      faviconDomain: 'antigma.ai',
      homepageUrl: 'https://github.com/AntigmaLabs/ante-preview'
    },
    {
      id: 'trae',
      label: translate('auto.lib.agent.catalog.060d152fb5', 'Trae'),
      // Why: matches TUI_AGENT_CONFIG.trae.detectCmd, not the ambiguous `trae-cli` — see the Why there.
      cmd: 'traecli',
      // Why: bare `trae.cn` 404s on Google's favicon service.
      faviconDomain: 'www.trae.cn',
      homepageUrl: 'https://docs.trae.cn/cli_get-started-with-trae-cli'
    },
    {
      id: 'muse',
      label: translate('auto.lib.agent.catalog.muse_label', 'Muse'),
      cmd: 'muse',
      faviconDomain: 'dev.meta.ai',
      homepageUrl: 'https://dev.meta.ai/docs/muse-code'
    },
    {
      id: 'dsh',
      label: translate('auto.lib.agent.catalog.dsh_label', 'DeepSeek Harness'),
      cmd: 'dsh-tui',
      searchAliases: ['deepseek', 'dsh', 'dst', 'deepseek harness'],
      homepageUrl: 'https://deepseek-harness.github.io/deepseek-harness/'
    },
    createReasonixAgentCatalogEntry(),
    {
      id: 'qoder',
      label: translate('auto.lib.agent.catalog.qoder_label', 'Qoder CLI'),
      cmd: 'qodercli',
      faviconDomain: 'qoder.com',
      homepageUrl: 'https://docs.qoder.com/cli/overview'
    },
    {
      id: 'qoder-cn',
      label: translate('auto.lib.agent.catalog.qoder_cn_label', 'Qoder CLI China'),
      cmd: 'qoderclicn',
      faviconDomain: 'qoder.cn',
      homepageUrl: 'https://docs.qoder.cn/cli/overview'
    },
    {
      id: 'zcode',
      label: translate('auto.lib.agent.catalog.zcode_label', 'ZCode'),
      cmd: 'zcode',
      faviconDomain: 'zcode.z.ai',
      homepageUrl: 'https://zcode.z.ai/en/docs'
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
      searchAliases: ['oh-my-pi', 'oh my pi'],
      // Why: no faviconDomain — omp renders the hand-authored OmpIcon glyph, so a
      // favicon fallback would never be reached.
      homepageUrl: 'https://omp.sh'
    },
    {
      id: 'prime-agent',
      label: translate('auto.lib.agent.catalog.d443a47995', 'Prime Agent'),
      cmd: 'prime-agent',
      faviconDomain: 'primeintellect.ai',
      homepageUrl: 'https://github.com/PrimeIntellect-ai/prime-agent'
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
    }
  ]
}
