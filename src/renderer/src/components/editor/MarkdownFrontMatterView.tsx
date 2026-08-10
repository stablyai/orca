import type React from 'react'
import {
  parseFrontMatterFields,
  stripFrontMatterDelimiters,
  type FrontMatterField
} from './markdown-frontmatter-fields'

// Renders a raw front-matter block as a key/value table, falling back to the
// raw text for TOML or any non-map YAML. Shared by the rich editor banner and
// the markdown preview so both surfaces stay in sync.
export function MarkdownFrontMatterView({
  raw,
  maxHeightClass = 'max-h-32'
}: {
  raw: string
  maxHeightClass?: string
}): React.JSX.Element {
  const fields = parseFrontMatterFields(raw)

  if (!fields) {
    return (
      <pre
        className={`${maxHeightClass} overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor`}
      >
        {stripFrontMatterDelimiters(raw)}
      </pre>
    )
  }

  return <FrontMatterTable fields={fields} maxHeightClass={maxHeightClass} />
}

function FrontMatterTable({
  fields,
  maxHeightClass
}: {
  fields: FrontMatterField[]
  maxHeightClass: string
}): React.JSX.Element {
  return (
    <div className={`${maxHeightClass} overflow-auto scrollbar-editor`}>
      <table className="w-full border-collapse text-xs">
        <tbody>
          {fields.map((field) => (
            <tr key={field.key} className="border-b border-border/40 last:border-b-0">
              {/* w-[1%] + nowrap shrinks the key column to its content so the value column takes the rest. */}
              <td className="w-[1%] py-1 pr-3 align-top font-medium text-muted-foreground whitespace-nowrap">
                {field.key}
              </td>
              <td className="py-1 align-top break-words text-foreground/80">{field.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
