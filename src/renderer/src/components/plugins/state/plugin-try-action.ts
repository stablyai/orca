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

// Why built in: catalog grammars ship no sample, and an empty file shows no highlighting.
const SYNTAX_SAMPLES: Readonly<Record<string, string>> = {
  '.gleam':
    'import gleam/io\n\n// Greets whoever runs it.\npub fn main() -> Nil {\n  let count = 3\n  io.println("Hello from Gleam!")\n}\n',
  '.prisma':
    '// A user table.\nmodel User {\n  id    Int     @id @default(autoincrement())\n  email String  @unique\n  name  String?\n}\n',
  '.nix':
    '{ pkgs ? import <nixpkgs> { } }:\n\n# A development shell.\npkgs.mkShell {\n  packages = [ pkgs.nodejs ];\n  shellHook = "echo ready";\n}\n',
  '.gd':
    'extends Node2D\n\n# Moves right every frame.\nvar speed := 120.0\n\nfunc _process(delta: float) -> void:\n\tposition.x += speed * delta\n',
  '.tex':
    '\\documentclass{article}\n\n% A tiny document.\n\\begin{document}\n\\section{Hello}\nInline math: $e^{i\\pi} + 1 = 0$.\n\\end{document}\n'
}

export function pluginSyntaxSample(
  syntaxes: readonly { extensions: readonly string[] }[]
): { extension: string; content: string } | null {
  for (const extension of syntaxes.flatMap((syntax) => syntax.extensions)) {
    const content = SYNTAX_SAMPLES[extension.toLowerCase()]
    if (content) {
      return { extension, content }
    }
  }
  return null
}

/** Runs `act` over the workspace Settings came from, or says why it can't. */
function fromSettingsToWorkspace(act: () => void): void {
  const reason = pluginPanelUnavailableReason(useAppStore.getState())
  if (reason) {
    toast.info(reason)
    return
  }
  act()
}

export function openPluginSampleFromSettings(sample: { extension: string; content: string }): void {
  fromSettingsToWorkspace(() => {
    const state = useAppStore.getState()
    state.closeSettingsPage()
    void state.openSampleFileInActiveWorkspace(sample)
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
  const sample = pluginSyntaxSample(contributes.syntaxes)
  if (sample) {
    return () => openPluginSampleFromSettings(sample)
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
