import { expect, it } from 'vitest'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

it('promotes a standalone reference image link with its definition title and link text', () => {
  const paragraph = {
    type: 'paragraph',
    children: [
      {
        type: 'linkReference',
        identifier: 'CHART',
        children: [{ type: 'text', value: 'Chart' }]
      }
    ]
  }
  remarkNativeChatFileDestinations()({
    type: 'root',
    children: [
      paragraph,
      {
        type: 'definition',
        identifier: 'chart',
        url: 'screenshots/chart.png',
        title: 'Quarterly results'
      }
    ]
  })

  expect(paragraph.children).toEqual([
    {
      type: 'image',
      url: 'screenshots/chart.png',
      title: 'Quarterly results',
      alt: 'Chart'
    }
  ])
})
