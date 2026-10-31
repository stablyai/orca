import { useRef, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Input } from '../ui/input'
import { WorkspaceEmojiPickerButton } from './WorkspaceEmojiPickerButton'
import { WorkspaceEmojiPickerPanel } from './WorkspaceEmojiPickerPanel'

function FieldWithButton(): React.JSX.Element {
  const [value, setValue] = useState('user-support')
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        aria-label="Display name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        adornment="trailing"
      />
      <WorkspaceEmojiPickerButton
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        inputRef={inputRef}
        onValueChange={setValue}
      />
    </div>
  )
}

export const field = defineFixture({ width: 420, render: () => <FieldWithButton /> })

export const panel = defineFixture({
  width: 320,
  render: () => (
    <div className="w-fit rounded-md border border-border bg-floating-surface shadow-floating">
      <WorkspaceEmojiPickerPanel onPick={() => {}} />
    </div>
  )
})
