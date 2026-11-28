import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PluginDeclarativeCodeInput } from './PluginDeclarativeCodeInput'

const emit = (): void => {}

const completions = [
  { label: 'status', detail: 'field', kind: 'field' as const },
  { label: 'total', detail: 'field', kind: 'field' as const },
  { label: '$gt', detail: 'greater than', kind: 'operator' as const },
  { label: '$gte', detail: 'greater than or equal', kind: 'operator' as const },
  { label: '$in', detail: 'in a list', kind: 'operator' as const }
]

export const oneLine = defineFixture({
  width: 360,
  render: () => (
    <PluginDeclarativeCodeInput
      props={{
        label: 'Filter',
        language: 'javascript',
        defaultValue: "{ status: 'shipped', total: { $gt: 100 } }",
        maxRows: 4
      }}
      emit={emit}
    />
  )
})

export const marked = defineFixture({
  width: 360,
  render: () => (
    <PluginDeclarativeCodeInput
      props={{
        label: 'Filter',
        language: 'javascript',
        invalid: true,
        defaultValue: '{\n  status: shipped\n  total: 1\n}',
        rows: 3,
        maxRows: 8,
        diagnostics: [{ from: 22, to: 27, message: "Expected ',' or '}'" }]
      }}
      emit={emit}
    />
  )
})

export const suggesting = defineFixture({
  width: 360,
  render: () => (
    <PluginDeclarativeCodeInput
      props={{ label: 'Filter', language: 'javascript', defaultValue: '{ total: { ', completions }}
      emit={emit}
    />
  ),
  interact: (frame) => {
    const field = frame.querySelector('textarea')
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
    // A real input event, as typing sends, so the suggestions open.
    document.execCommand('insertText', false, '$g')
  }
})

// The guest's view of each edit, for the real-browser spec to read.
const record = (_callback: string, args: readonly unknown[]): void => {
  document.documentElement.dataset.codeInputEmitted = String(args[0])
}

export const atMaxLength = defineFixture({
  width: 360,
  render: () => (
    <PluginDeclarativeCodeInput
      props={{
        label: 'Filter',
        defaultValue: 'to + x',
        maxLength: 8,
        completions: [{ label: 'total' }],
        onChange: { $callback: 'change' }
      }}
      emit={record}
    />
  )
})
