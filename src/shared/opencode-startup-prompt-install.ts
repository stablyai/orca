import { join } from 'node:path'
import { writeOpenCodeTuiPluginDirectory } from './opencode-tui-plugin-install'

export const OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY = 'orca-opencode-startup-prompt'

export function writeOpenCodeStartupPromptPlugin(
  configDir: string,
  source: string,
  ownership: 'canonical' | 'overlay' = 'canonical'
): void {
  writeOpenCodeTuiPluginDirectory(
    join(configDir, 'plugins'),
    OPENCODE_STARTUP_PROMPT_PLUGIN_DIRECTORY,
    source,
    ownership
  )
}
