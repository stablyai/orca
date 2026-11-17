import { defineFixture } from '../../component-fixtures/component-fixture'
import { Select, SelectTrigger, SelectValue } from './select'
import { Toggle } from './toggle'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

function selectionControlsFixture(focusedSlot?: string) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <span className="w-20 text-xs text-muted-foreground">Toggle</span>
          <Toggle variant="outline">Wrap lines</Toggle>
          <Toggle variant="outline" disabled>
            Disabled
          </Toggle>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 text-xs text-muted-foreground">Select</span>
          <Select open={false}>
            <SelectTrigger aria-label="Host">
              <SelectValue placeholder="Local host" />
            </SelectTrigger>
          </Select>
          <Select open={false} disabled>
            <SelectTrigger aria-label="Disabled host">
              <SelectValue placeholder="Disabled" />
            </SelectTrigger>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-20 text-xs text-muted-foreground">Group</span>
          <ToggleGroup type="single" defaultValue="files" variant="outline">
            <ToggleGroupItem value="files">Files</ToggleGroupItem>
            <ToggleGroupItem value="changes">Changes</ToggleGroupItem>
            <ToggleGroupItem value="history" disabled>
              Disabled
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    ),
    interact: (frame) =>
      frame.querySelector<HTMLButtonElement>(`[data-slot="${focusedSlot}"]`)?.focus()
  })
}

export const selectionControls = selectionControlsFixture()

export const focusedToggle = selectionControlsFixture('toggle')

export const focusedSelect = selectionControlsFixture('select-trigger')

export const focusedToggleGroup = selectionControlsFixture('toggle-group-item')
