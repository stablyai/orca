import { Smartphone } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function EmulatorUnavailablePane() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-sm text-muted-foreground">
      <Smartphone className="size-8 text-muted-foreground" />
      <p className="max-w-md font-medium text-foreground">
        {translate(
          'auto.components.emulator.pane.emulator.unavailable.pane.b2c268a0b9',
          'Mobile Emulator is macOS only'
        )}
      </p>
      <p className="max-w-md text-xs">
        {translate(
          'auto.components.emulator.pane.emulator.unavailable.pane.f630b9ca9f',
          'Mobile Emulator requires a Mac with Xcode and the iOS Simulator runtime. On Linux or Windows, use a physical device or a remote Mac build host.'
        )}
      </p>
    </div>
  )
}
