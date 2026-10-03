import { Button } from '@/components/ui/button'
import type { PluginMarkdownOutput } from '../../../../shared/plugins/plugin-markdown-renderer'
import type { NativeMarkdownRenderContextValue } from './native-markdown-render-context'

type Cell = Extract<PluginMarkdownOutput, { kind: 'list' }>['items'][number]

function keyedOutputValues<T>(values: readonly T[]): { key: string; value: T }[] {
  const occurrences = new Map<string, number>()
  return values.map((value) => {
    const content = JSON.stringify(value)
    const ordinal = occurrences.get(content) ?? 0
    occurrences.set(content, ordinal + 1)
    return { key: `${content}:${ordinal}`, value }
  })
}

function OutputCell({ cell, context }: { cell: Cell; context: NativeMarkdownRenderContextValue }) {
  const content = cell.reference ? (
    <Button
      variant="link"
      size="sm"
      onClick={() => cell.reference && context.openReference(cell.reference)}
    >
      {cell.text}
    </Button>
  ) : (
    cell.text
  )
  return (
    <span
      data-state={cell.state}
      className={
        cell.state === 'error'
          ? 'text-destructive'
          : cell.state === 'missing'
            ? 'text-muted-foreground'
            : undefined
      }
    >
      {content}
    </span>
  )
}

export function NativeMarkdownOutput({
  output,
  context
}: {
  output: PluginMarkdownOutput
  context: NativeMarkdownRenderContextValue
}): React.JSX.Element {
  return (
    <div
      contentEditable={false}
      className="my-2 overflow-auto scrollbar-editor"
      data-native-markdown-output
    >
      {output.kind === 'table' ? (
        <table>
          <thead>
            <tr>
              {keyedOutputValues(output.columns).map(({ value: column, key }) => (
                <th key={key}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyedOutputValues(output.rows).map(({ value: row, key }) => (
              <tr key={key}>
                {keyedOutputValues(row).map(({ value: cell, key: cellKey }) => (
                  <td key={cellKey}>
                    <OutputCell cell={cell} context={context} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : output.kind === 'list' ? (
        <ul>
          {keyedOutputValues(output.items).map(({ value: cell, key }) => (
            <li key={key}>
              <OutputCell cell={cell} context={context} />
            </li>
          ))}
        </ul>
      ) : output.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {output.message}
        </p>
      ) : (
        <p className="whitespace-pre-wrap">{output.text}</p>
      )}
    </div>
  )
}
