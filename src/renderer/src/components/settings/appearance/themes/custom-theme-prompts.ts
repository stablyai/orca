import type { ThemeStudioSavedTheme } from '../../../../../../shared/theme-studio/theme-studio-protocol'

// Why English prompts: they are instructions for the agent, which reads them as written.

/** What "Edit with your agent" copies: enough for any agent in an Orca terminal to start. */
export function customThemeEditPrompt(theme: ThemeStudioSavedTheme): string {
  return [
    `Edit my Orca theme "${theme.name}" with the orca CLI.`,
    'First load the guide: orca skills get orca-cli --reference references/themes.md',
    `Start from it with: orca theme edit --from ${theme.pluginKey}`,
    'Preview your changes in both light and dark, check contrast, and ask me before keeping them.'
  ].join('\n')
}

/** What "Publish with your agent" copies: a flow that shows everything before anything is public. */
export function customThemePublishPrompt(theme: ThemeStudioSavedTheme): string {
  return [
    `Publish my Orca theme "${theme.name}" (${theme.pluginKey}) on GitHub so others can install it.`,
    'Load the guides first: orca skills get orca-cli --reference references/themes.md and orca skills get orca-plugin-authoring',
    `Write the plugin folder with: orca theme edit --from ${theme.pluginKey}, then orca theme export <folder>`,
    'Before creating a repository, pushing, tagging or opening any pull request, show me exactly what will be published and where, and wait for my yes.'
  ].join('\n')
}
