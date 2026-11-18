import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CodexHomeImport, CodexHomeImportForm } from './CodexHomeImport'

function importForm(width: number, invalidPath = false) {
  return defineFixture({
    width,
    interact: async (frame) => {
      if (!invalidPath) {
        return
      }
      const input = frame.querySelector('input')
      if (!input) {
        throw new Error('Codex home input missing')
      }
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'relative-home'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(requestAnimationFrame)
      frame.querySelector('form')?.requestSubmit()
    },
    render: () => (
      <div className="bg-background p-4 text-foreground">
        <CodexHomeImportForm
          runtime={{ runtime: 'host', label: 'Windows' }}
          disabled={false}
          runAction={async () => {}}
          onImported={() => {}}
        />
      </div>
    )
  })
}

export const desktop = importForm(420)
export const narrow = importForm(360)

export const validation = importForm(420, true)

function popoverFixture(width: number) {
  return defineFixture({
    width,
    render: () => (
      <div className="h-96 bg-background p-4 text-foreground">
        <CodexHomeImport
          runtime={{ runtime: 'host', label: 'Windows' }}
          disabled={false}
          runAction={async () => {}}
        />
      </div>
    ),
    interact: async (frame) => {
      frame.querySelector('button')?.click()
    }
  })
}

export const popover = popoverFixture(420)
export const popoverNarrow = popoverFixture(360)
