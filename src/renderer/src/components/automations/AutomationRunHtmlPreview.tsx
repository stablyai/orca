import React from 'react'
import { AUTOMATION_OUTPUT_FRAME_NAME_PREFIX } from '../../../../shared/automation-output-preview'
import { htmlPreviewWithInertLinks } from '../../../../shared/html-preview-inert-links'

const HTML_PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'"
const MIN_HEIGHT = 120

function isolatedHtml(content: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}">${htmlPreviewWithInertLinks(content)}`
}

export function AutomationRunHtmlPreview({
  id,
  title,
  content
}: {
  id: string
  title: string
  content: string
}): React.JSX.Element {
  const [height, setHeight] = React.useState(MIN_HEIGHT)
  const srcDoc = React.useMemo(() => isolatedHtml(content), [content])
  return (
    <iframe
      name={`${AUTOMATION_OUTPUT_FRAME_NAME_PREFIX}${id}`}
      title={title}
      // Height measurement needs same-origin; scripts stay disabled and the host blocks navigation.
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
      style={{ height }}
      onLoad={(event) => {
        const body = event.currentTarget.contentDocument?.documentElement
        if (body) {
          setHeight(Math.max(MIN_HEIGHT, body.scrollHeight))
        }
      }}
      className="mt-2 block w-full rounded-lg border border-border/50 bg-white"
    />
  )
}
