import { useEffect, useState } from 'react'
import { EyeOff } from 'lucide-react'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { translate } from '@/i18n/i18n'

export function IncognitoProjectsPrivacySection(): React.JSX.Element {
  // Why null: render the switch only once main has said which way it is set.
  const [allowScreenCapture, setAllowScreenCapture] = useState<boolean | null>(null)
  const label = translate(
    'incognitoProjects.hideFromScreenCaptureLabel',
    'Hide Orca from screen sharing while incognito projects are shown'
  )
  const isLinux = navigator.userAgent.includes('Linux')

  useEffect(() => {
    let stale = false
    void window.api.incognitoProjects
      .getState()
      .then((state) => {
        if (!stale) {
          setAllowScreenCapture(state.allowScreenCapture)
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <EyeOff className="size-4" />
          <Label>{label}</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {isLinux
            ? translate(
                'incognitoProjects.hideFromScreenCaptureLinux',
                'Linux has no way for an app to block screen capture, so this has no effect here. Lock incognito projects before sharing your screen.'
              )
            : translate(
                'incognitoProjects.hideFromScreenCaptureDescription',
                'Screen sharing, recording and screenshot tools see a blank Orca window until incognito projects are locked again. Incognito only hides projects on screen; it does not encrypt anything.'
              )}
        </p>
      </div>
      <Switch
        checked={allowScreenCapture === false}
        disabled={allowScreenCapture === null}
        aria-label={label}
        onCheckedChange={(hide) => {
          void window.api.incognitoProjects
            .setAllowScreenCapture({ allow: !hide })
            .then((state) => setAllowScreenCapture(state.allowScreenCapture))
            .catch(() => {})
        }}
      />
    </div>
  )
}
