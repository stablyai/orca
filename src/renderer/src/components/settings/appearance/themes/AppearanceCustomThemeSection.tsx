import { useState } from 'react'
import { Copy, Download, MoreHorizontal, Pencil, Send, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type {
  ThemeStudioSavedActionResult,
  ThemeStudioSavedTheme
} from '../../../../../../shared/theme-studio/theme-studio-protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { usePluginThemes } from '@/store/plugins/appearance/plugin-themes'
import { useThemeStudioPreviewStore } from '@/store/appearance/theme-studio-preview-store'
import { sendThemeStudioUserAction } from '@/app-shell/appearance/theme-studio-bridge'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { CustomThemeDeleteDialog, CustomThemeRenameDialog } from './CustomThemeDialogs'
import { customThemeEditPrompt, customThemePublishPrompt } from './custom-theme-prompts'

type Translate = ReturnType<typeof useTranslate>

async function copyPrompt(text: string, t: Translate): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      t('settings.appearance.customTheme.promptCopied', 'Prompt copied. Paste it into your agent.')
    )
  } catch {
    toast.error(t('settings.appearance.customTheme.copyFailed', 'Could not copy the prompt.'))
  }
}

async function runAction(
  request: Parameters<typeof window.api.themeStudio.savedAction>[0],
  t: Translate,
  done: (path: string | undefined) => string
): Promise<void> {
  const result: ThemeStudioSavedActionResult = await window.api.themeStudio
    .savedAction(request)
    .catch((error: unknown): ThemeStudioSavedActionResult => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }))
  if (result.ok) {
    toast.success(done(result.path))
  } else if (!result.cancelled) {
    toast.error(
      t('settings.appearance.customTheme.failed', 'Could not do that: {{message}}', {
        message: result.message ?? ''
      })
    )
  }
}

function madeByLine(theme: ThemeStudioSavedTheme, modes: string, t: Translate): string {
  const when = new Intl.DateTimeFormat(getIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(theme.savedAt)
  return theme.by && theme.by !== 'you'
    ? t('settings.appearance.customTheme.madeBy', 'Made by {{by}} · {{when}} · {{modes}}', {
        by: theme.by,
        when,
        modes
      })
    : t('settings.appearance.customTheme.savedBy', 'Saved by you · {{when}} · {{modes}}', {
        when,
        modes
      })
}

function CustomThemeRow({
  theme,
  modes
}: {
  theme: ThemeStudioSavedTheme
  modes: string
}): React.JSX.Element {
  const t = useTranslate()
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  return (
    <>
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-2">
            {theme.name}
            <Badge variant="secondary">
              {t('settings.appearance.customTheme.badge', 'Custom')}
            </Badge>
          </span>
        }
        description={madeByLine(theme, modes, t)}
        control={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copyPrompt(customThemeEditPrompt(theme), t)}
            >
              <Sparkles className="size-3.5" />
              {t('settings.appearance.customTheme.editWithAgent', 'Edit with your agent')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('settings.appearance.customTheme.more', 'More actions')}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog('rename')}>
                  <Pencil className="size-3.5" />
                  {t('settings.appearance.customTheme.rename', 'Rename…')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void runAction({ action: 'duplicate', pluginKey: theme.pluginKey }, t, () =>
                      t('settings.appearance.customTheme.duplicated', 'Duplicated.')
                    )
                  }
                >
                  <Copy className="size-3.5" />
                  {t('settings.appearance.customTheme.duplicate', 'Duplicate')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void runAction({ action: 'export', pluginKey: theme.pluginKey }, t, (path) =>
                      t('settings.appearance.customTheme.exportedTo', 'Exported to {{path}}', {
                        path: path ?? ''
                      })
                    )
                  }
                >
                  <Download className="size-3.5" />
                  {t('settings.appearance.customTheme.export', 'Export…')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void copyPrompt(customThemePublishPrompt(theme), t)}
                >
                  <Send className="size-3.5" />
                  {t('settings.appearance.customTheme.publish', 'Publish with your agent')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog('delete')}>
                  <Trash2 className="size-3.5" />
                  {t('settings.appearance.customTheme.delete', 'Delete…')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <CustomThemeRenameDialog
        open={dialog === 'rename'}
        name={theme.name}
        onClose={() => setDialog(null)}
        onRename={(name) =>
          runAction({ action: 'rename', pluginKey: theme.pluginKey, name }, t, () =>
            t('settings.appearance.customTheme.renamed', 'Renamed.')
          )
        }
      />
      <CustomThemeDeleteDialog
        open={dialog === 'delete'}
        name={theme.name}
        onClose={() => setDialog(null)}
        onDelete={() =>
          runAction({ action: 'delete', pluginKey: theme.pluginKey }, t, () =>
            t('settings.appearance.customTheme.deleted', 'Deleted.')
          )
        }
      />
    </>
  )
}

function DraftRow(): React.JSX.Element | null {
  const t = useTranslate()
  const preview = useThemeStudioPreviewStore((state) => state.preview)
  if (!preview) {
    return null
  }
  const { last } = preview
  return (
    <SettingsRow
      label={
        <span className="inline-flex items-center gap-2">
          {t('auto.app-shell.themeStudio.previewing', 'Previewing {{value0}}', {
            value0: preview.draft.name
          })}
          <Badge variant="outline">
            {t('settings.appearance.customTheme.draftBadge', 'Not saved')}
          </Badge>
        </span>
      }
      description={
        last?.by
          ? t('auto.app-shell.themeStudio.lastBy', '{{label}} · by {{by}}', {
              label: last.label,
              by: last.by
            })
          : last?.label
      }
      control={
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={() => sendThemeStudioUserAction('keep')}>
            {t('auto.app-shell.themeStudio.keep', 'Keep')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={preview.canUndo !== true}
            onClick={() => sendThemeStudioUserAction('undo')}
          >
            {t('auto.app-shell.themeStudio.undo', 'Undo')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => sendThemeStudioUserAction('discard')}>
            {t('auto.app-shell.themeStudio.discard', 'Discard')}
          </Button>
        </div>
      }
    />
  )
}

/** Settings → Appearance: the agent's draft being previewed, and the custom themes, as
 *  first-class rows with what made them and what can be done with them. */
export function AppearanceCustomThemeSection({
  settings
}: {
  settings: Pick<GlobalSettings, 'pluginAppThemeDark' | 'pluginAppThemeLight'>
}): React.JSX.Element | null {
  const t = useTranslate()
  const saved = useThemeStudioPreviewStore((state) => state.saved)
  const themes = usePluginThemes()
  const modesOf = (pluginKey: string): string[] =>
    [
      themes.some(
        (theme) => theme.pluginKey === pluginKey && theme.id === settings.pluginAppThemeLight
      )
        ? t('settings.appearance.customTheme.light', 'light')
        : null,
      themes.some(
        (theme) => theme.pluginKey === pluginKey && theme.id === settings.pluginAppThemeDark
      )
        ? t('settings.appearance.customTheme.dark', 'dark')
        : null
    ].filter((mode) => mode !== null)
  // Why every saved theme, in-use first: a duplicate or an unused theme still needs its actions.
  const ordered = [...saved].sort(
    (left, right) => modesOf(right.pluginKey).length - modesOf(left.pluginKey).length
  )
  return (
    <div data-theme-studio-settings>
      <DraftRow />
      {ordered.map((theme) => {
        const modes = modesOf(theme.pluginKey)
        return (
          <CustomThemeRow
            key={theme.pluginKey}
            theme={theme}
            modes={
              modes.length
                ? t('settings.appearance.customTheme.inUse', 'In use for {{modes}}', {
                    modes: modes.join(' & ')
                  })
                : t('settings.appearance.customTheme.notInUse', 'Not in use')
            }
          />
        )
      })}
    </div>
  )
}
