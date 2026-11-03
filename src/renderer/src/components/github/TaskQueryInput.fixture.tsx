import { useRef, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import TaskQueryInput from './TaskQueryInput'

function Filter({ initialValue }: { initialValue: string }): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TaskQueryInput
        value={value}
        inputRef={inputRef}
        showClear={Boolean(value)}
        onClear={() => setValue('')}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search GitHub PRs..."
      />
    </div>
  )
}

export const syntax = defineFixture({
  render: () => (
    <Filter initialValue='is:pr (author:alice OR author:bob) AND label:"needs review"' />
  ),
  width: 900
})

export const parameters = defineFixture({
  render: () => <Filter initialValue="is:pr" />,
  width: 900,
  interact: (frame) => {
    const trigger = frame.querySelector('button')
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})

export const narrow = defineFixture({
  render: () => <Filter initialValue="is:pr author:alice OR author:bob" />,
  width: 420
})
