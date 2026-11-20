import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatImageViewer } from './NativeChatImageAttachments'

function swatch(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${color}"/></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

const BLOCKS = [
  ['r0.png', '#4f7cac'],
  ['r90.png', '#7ca24f'],
  ['r180.png', '#ac7c4f'],
  ['r270.png', '#a24f7c']
].map(([name, color]) => ({
  type: 'image-ref' as const,
  url: swatch(color),
  alt: name
}))

function Gallery(): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(2)
  return (
    <NativeChatImageViewer
      blocks={BLOCKS}
      index={index}
      onIndexChange={setIndex}
      runtimeContext={null}
    />
  )
}

/** The preview modal opened on the third of four images: edge arrows and the n / m counter. */
export const gallery = defineFixture({
  width: 900,
  render: () => <Gallery />
})
