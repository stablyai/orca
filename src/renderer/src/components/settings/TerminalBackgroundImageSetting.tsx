import { useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { useTerminalBackgroundImageUrl } from '@/components/terminal-pane/terminal-background-image-blob'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type TerminalBackgroundImageSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Desktop-only settings row to pick, preview, replace, or remove the terminal
 *  background image. Renders null on the web client, which has no file picker. */
export function TerminalBackgroundImageSetting({
  settings,
  updateSettings
}: TerminalBackgroundImageSettingProps): React.JSX.Element | null {
  const mountedRef = useMountedRef()
  const [picking, setPicking] = useState(false)
  const backgroundImage = settings.terminalBackgroundImage ?? null
  const backgroundImageUrl = useTerminalBackgroundImageUrl(backgroundImage)

  // Why: picking a file needs main's native dialog and local disk; the web
  // client has neither, so the whole row is desktop-only.
  if (isPairedWebClientWindow()) {
    return null
  }

  const handlePick = async (): Promise<void> => {
    if (picking) {
      return
    }
    setPicking(true)
    try {
      const picked = await window.api.terminalBackground.pick()
      if (!picked) {
        return
      }
      const previous = settings.terminalBackgroundImage ?? null
      const opacity = settings.terminalBackgroundOpacity
      // Why: only nudge opacity when adding the *first* image and it is still
      // fully opaque — otherwise the image would be invisible and the pick would
      // appear to do nothing. Replacing an existing image never touches opacity,
      // so a user who deliberately set it (even to 1) keeps their value.
      const shouldNudgeOpacity = !previous && (opacity === undefined || opacity >= 1)
      updateSettings({
        terminalBackgroundImage: picked,
        ...(shouldNudgeOpacity ? { terminalBackgroundOpacity: 0.85 } : {})
      })
      // Why: delete the replaced file after the settings write. The blob URL is
      // released automatically when the last pane stops displaying it, and the
      // main-side startup prune reclaims anything a dropped delete leaves behind.
      if (previous && previous.id !== picked.id) {
        void window.api.terminalBackground.delete(previous.id, previous.fileName)
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.TerminalBackgroundImageSetting.7de41b02c9',
              'Failed to set the background image.'
            )
      )
    } finally {
      if (mountedRef.current) {
        setPicking(false)
      }
    }
  }

  const handleClear = (): void => {
    const current = settings.terminalBackgroundImage
    if (!current) {
      return
    }
    // Why: settings first, file cleanup after — a crash in between leaks at
    // most one orphaned file (reclaimed by the startup prune), never a dangling
    // settings reference. The blob URL is released when panes drop the image.
    updateSettings({ terminalBackgroundImage: null })
    void window.api.terminalBackground.delete(current.id, current.fileName)
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.TerminalBackgroundImageSetting.5c19a473d2',
        'Background Image'
      )}
      description={translate(
        'auto.components.settings.TerminalBackgroundImageSetting.b40c4de821',
        'Show an image behind the terminal panes.'
      )}
      keywords={['background', 'image', 'skin', 'wallpaper', 'picture', 'theme']}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.TerminalBackgroundImageSetting.5c19a473d2',
              'Background Image'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {backgroundImage?.label
              ? backgroundImage.label
              : translate(
                  'auto.components.settings.TerminalBackgroundImageSetting.19f2f04f3e',
                  'Shown behind the terminal panes while Background Opacity is below 1.'
                )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {backgroundImageUrl ? (
            <div
              aria-hidden
              className="h-8 w-12 rounded-md border border-border/50 bg-cover bg-center"
              style={{ backgroundImage: `url(${backgroundImageUrl})` }}
            />
          ) : null}
          {backgroundImage ? (
            <Button variant="ghost" size="sm" disabled={picking} onClick={handleClear}>
              {translate(
                'auto.components.settings.TerminalBackgroundImageSetting.e0e4a53d38',
                'Remove'
              )}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={picking}
            onClick={() => void handlePick()}
          >
            <ImagePlus className="size-4" />
            {backgroundImage
              ? translate(
                  'auto.components.settings.TerminalBackgroundImageSetting.a34c1e30d5',
                  'Change…'
                )
              : translate(
                  'auto.components.settings.TerminalBackgroundImageSetting.4f6ab2c9e1',
                  'Choose Image…'
                )}
          </Button>
        </div>
      </div>
    </SearchableSetting>
  )
}
