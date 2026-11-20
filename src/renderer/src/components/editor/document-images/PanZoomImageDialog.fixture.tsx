import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PanZoomImageDialog } from './PanZoomImageDialog'

const diagram = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#f8fafc"/><path d="M400 500H1200" stroke="#64748b" stroke-width="8"/><rect x="120" y="350" width="400" height="300" rx="24" fill="#dbeafe" stroke="#2563eb" stroke-width="4"/><rect x="1080" y="350" width="400" height="300" rx="24" fill="#dcfce7" stroke="#16a34a" stroke-width="4"/><g font-family="sans-serif" font-size="48" text-anchor="middle" fill="#0f172a"><text x="320" y="515">Input</text><text x="1280" y="515">Output</text></g></svg>`

export const diagramPreview = defineFixture({
  width: 1000,
  render: () => (
    <PanZoomImageDialog
      open
      onOpenChange={() => {}}
      src={`data:image/svg+xml,${encodeURIComponent(diagram)}`}
      size={{ width: 1600, height: 1000 }}
      title="Diagram preview"
    />
  )
})
