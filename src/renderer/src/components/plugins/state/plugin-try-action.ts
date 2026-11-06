import { toast } from 'sonner'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { isUsablePluginLanguagePack } from '../../../../../shared/plugins/languages/plugin-language-pack-coverage'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { collectActivePluginNewFiles } from '@/store/plugin-new-files'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { pluginPanelUnavailableReason } from '../page/plugin-contribution-action-availability'
import {
  switchBackFromPluginLanguage,
  switchToPluginLanguage
} from '../page/PluginContributionActionLanguage'
import { openPluginNewFileFromSettings } from '../page/PluginContributionActionNewFile'
import { openPluginPanelFromSettings } from '../page/PluginContributionActionPanel'
import { languageDisplayName } from '../presentation/plugin-contributions'
import { PLUGIN_ACTION_TOAST_DURATION_MS } from './plugin-action-toast'

/** Runs `act` over the workspace Settings came from, or says why it can't. */
function fromSettingsToWorkspace(act: () => void): void {
  const reason = pluginPanelUnavailableReason(useAppStore.getState())
  if (reason) {
    toast.info(reason)
    return
  }
  act()
}

/** The first file extension a plugin's grammars declare, which a blank file can show off. */
export function firstSyntaxExtension(
  syntaxes: readonly { extensions: readonly string[] }[]
): string | null {
  return syntaxes.find((syntax) => syntax.extensions.length > 0)?.extensions[0] ?? null
}

/** Opens a blank `untitled<extension>` so the plugin's grammar highlights as you type. */
export function openPluginBlankFileFromSettings(extension: string): void {
  fromSettingsToWorkspace(() => {
    const state = useAppStore.getState()
    state.closeSettingsPage()
    void state.openBlankFileInActiveWorkspace(extension)
  })
}

/** Applies the plugin's file icons and shows them in the file tree. */
export function revealPluginIconTheme(apply: () => Promise<unknown>): void {
  fromSettingsToWorkspace(() => {
    void apply()
    const state = useAppStore.getState()
    state.closeSettingsPage()
    state.showRightSidebarFiles()
  })
}

const livePlugins = (pluginKey: string) =>
  usePluginPanelsStore.getState().plugins.filter((plugin) => plugin.pluginKey === pluginKey)

async function tryLanguagePack(pluginKey: string): Promise<void> {
  const entries = await usePluginLanguagePackStore.getState().fetchEntries()
  const pack = entries.find(
    (entry) => entry.pluginKey === pluginKey && isUsablePluginLanguagePack(entry)
  )
  if (!pack) {
    toast.info(
      translate(
        'auto.components.settings.pluginTryAction.incompleteLanguage',
        'This language pack is too incomplete to switch to.'
      )
    )
    return
  }
  if (!(await switchToPluginLanguage(pack))) {
    return
  }
  toast.success(
    translate('auto.components.settings.pluginThemeApply.nowUsing', 'Now using {{value0}}', {
      value0: languageDisplayName(pack.locale)
    }),
    {
      duration: PLUGIN_ACTION_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.settings.pluginThemeApply.switchBack', 'Switch back'),
        onClick: switchBackFromPluginLanguage
      }
    }
  )
}

/**
 * What "Try it" does right after install, or null when nothing shows the plugin off directly.
 * Chosen from the manifest; the live registrations it uses land after install, so read on click.
 */
export function pluginTryAction(
  pluginKey: string,
  manifest: Pick<PluginManifest, 'name' | 'contributes'>
): (() => void) | null {
  const { contributes } = manifest
  if (contributes.newFiles.length > 0) {
    return () => {
      const newFile = collectActivePluginNewFiles(livePlugins(pluginKey))[0]
      if (newFile) {
        fromSettingsToWorkspace(() => openPluginNewFileFromSettings(newFile))
      }
    }
  }
  const syntaxExtension = firstSyntaxExtension(contributes.syntaxes)
  if (syntaxExtension) {
    return () => openPluginBlankFileFromSettings(syntaxExtension)
  }
  if (contributes.languagePacks.length > 0) {
    return () => void tryLanguagePack(pluginKey)
  }
  if (contributes.panels.length > 0) {
    return () => {
      const panel = livePlugins(pluginKey)[0]?.panels[0]
      if (panel) {
        fromSettingsToWorkspace(() => openPluginPanelFromSettings(panel))
      }
    }
  }
  if (contributes.commands.length > 0) {
    return () => {
      const state = useAppStore.getState()
      state.closeSettingsPage()
      // Why the name: the palette matches plugin commands by their plugin's name.
      state.openModal('worktree-palette', { query: manifest.name })
    }
  }
  return null
}
