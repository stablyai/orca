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
    `Publish my Orca theme "${theme.name}" on GitHub so others can install it.`,
    'First load the guide: orca skills get orca-cli --reference references/themes.md',
    `Then run the dry run: orca theme publish ${theme.pluginKey}`,
    'Show me the plan (the folder, the public repository and every command). Only after I say yes, run it again with --yes.'
  ].join('\n')
}
