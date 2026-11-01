import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ensureClaudeAgentViewPlugin,
  installClaudeAgentView,
  removeClaudeAgentView
} from '../main/claude/agent-view-install'

export class RelayClaudeAgentViewPlugin {
  private source = ''

  constructor(private readonly homeDir: string) {}

  setSource(source: string | undefined): void {
    if (source !== undefined) {
      this.source = source
    }
  }

  materialize(
    instance: string,
    configDir = join(this.homeDir, '.claude')
  ): { pluginDir: string; configDir: string } | undefined {
    if (!this.source) {
      removeClaudeAgentView(join(configDir, 'settings.json'))
      return undefined
    }
    if (!installClaudeAgentView(join(configDir, 'settings.json'))) {
      return undefined
    }
    const id = createHash('sha256').update(instance).digest('hex').slice(0, 32)
    return {
      pluginDir: ensureClaudeAgentViewPlugin(
        join(this.homeDir, '.orca-relay', 'claude-plugins', id),
        this.source
      ),
      configDir
    }
  }
}
