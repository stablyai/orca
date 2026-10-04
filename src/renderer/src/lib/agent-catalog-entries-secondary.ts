import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from './agent-catalog'

/** The community tail of the catalog; see `primaryAgentCatalogEntries`. */
export function secondaryAgentCatalogEntries(): AgentCatalogEntry[] {
  return [
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
      id: 'freebuff',
      label: translate('auto.lib.agent.catalog.freebuff_label', 'Freebuff'),
      cmd: 'freebuff',
      faviconDomain: 'freebuff.com',
      homepageUrl: 'https://freebuff.com/cli'
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
      // Why: QwenLM/qwen-code installs its CLI executable as `qwen`; the package
      // name is not the binary users put on PATH. Keep `id` for stable identity.
      cmd: 'qwen',
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
    },
    {
      id: 'codebuddy',
      label: translate('auto.lib.agent.catalog.codebuddy_label', 'CodeBuddy'),
      cmd: 'codebuddy',
      faviconDomain: 'codebuddy.ai',
      homepageUrl: 'https://www.codebuddy.ai/cli'
    },
    {
      id: 'jcode',
      label: translate('auto.lib.agent.catalog.jcode_label', 'Jcode'),
      cmd: 'jcode',
      faviconDomain: 'jcode.sh',
      homepageUrl: 'https://github.com/1jehuang/jcode'
    }
  ]
}
