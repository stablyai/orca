import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatImageAttachments } from './NativeChatImageAttachments'

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea']

function screenshot(index: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="${COLORS[index]}"/><text x="600" y="400" font-family="sans-serif" font-size="96" fill="white" text-anchor="middle">Screenshot ${index + 1}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const blocks = COLORS.map((_, index) => ({
  type: 'image-ref' as const,
  url: screenshot(index),
  alt: `screenshot-${index + 1}.png`
}))

function openSecond(frame: HTMLElement): void {
  frame.querySelectorAll<HTMLButtonElement>('button')[1]?.click()
}

export const row = defineFixture({
  width: 560,
  render: () => <NativeChatImageAttachments blocks={blocks} runtimeContext={null} />
})
export const gallery = defineFixture({
  width: 560,
  render: () => <NativeChatImageAttachments blocks={blocks} runtimeContext={null} />,
  interact: openSecond
})
