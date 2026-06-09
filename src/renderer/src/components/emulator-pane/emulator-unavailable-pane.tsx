import { Smartphone } from 'lucide-react'

export function EmulatorUnavailablePane() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-sm text-muted-foreground">
      <Smartphone className="size-8 text-muted-foreground" />
      <p className="max-w-md font-medium text-foreground">Mobile Emulator is macOS only</p>
      <p className="max-w-md text-xs">
        Mobile Emulator requires a Mac with Xcode and the iOS Simulator runtime. On Linux or
        Windows, use a physical device or a remote Mac build host.
      </p>
    </div>
  )
}
