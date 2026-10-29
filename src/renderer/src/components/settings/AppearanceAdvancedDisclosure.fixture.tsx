import { defineFixture } from '../../component-fixtures/component-fixture'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'

function AdvancedFontControls(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="fixture-ligatures">Font ligatures</Label>
        <Switch id="fixture-ligatures" defaultChecked />
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="fixture-smoothing">Subpixel font smoothing</Label>
        <Switch id="fixture-smoothing" />
      </div>
    </div>
  )
}

export const collapsed = defineFixture({
  width: 420,
  render: () => (
    <AppearanceAdvancedDisclosure>
      <AdvancedFontControls />
    </AppearanceAdvancedDisclosure>
  )
})

export const expanded = defineFixture({
  width: 420,
  render: () => (
    <AppearanceAdvancedDisclosure>
      <AdvancedFontControls />
    </AppearanceAdvancedDisclosure>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
  }
})

// An active settings search force-opens the disclosure and disables its toggle.
export const forcedOpenBySearch = defineFixture({
  width: 420,
  store: { settingsSearchQuery: 'font' },
  render: () => (
    <AppearanceAdvancedDisclosure>
      <AdvancedFontControls />
    </AppearanceAdvancedDisclosure>
  )
})
