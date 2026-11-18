import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useDocumentDarkTheme } from '@/hooks/theme/use-document-dark-theme'
import MermaidBlock from './MermaidBlock'

const elkFlowchart = `---
config:
  layout: elk
---
flowchart TD
  A[Start] --> B{Ready?}
  B -->|Yes| C[Build]
  B -->|No| D[Wait]
  D --> B
  C --> E[Test]
  E --> F{Pass?}
  F -->|Yes| G[Ship]
  F -->|No| C
  G --> H[Done]`

function ElkFlowchartFixture() {
  const isDark = useDocumentDarkTheme()
  return (
    <div className="bg-background p-6">
      <MermaidBlock content={elkFlowchart} isDark={isDark} />
    </div>
  )
}

export const elkLayout = defineFixture({
  width: 640,
  render: () => <ElkFlowchartFixture />,
  interact: async (frame) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (frame.querySelector('svg')) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('The Mermaid diagram did not render')
  }
})
