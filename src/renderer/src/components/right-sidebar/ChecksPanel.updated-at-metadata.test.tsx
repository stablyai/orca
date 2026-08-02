// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChecksPanelUpdatedAtMetadata } from './checks-panel-updated-at-metadata'

function renderMetadataText(reviewShortLabel: string): string {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(
    <ChecksPanelUpdatedAtMetadata
      reviewShortLabel={reviewShortLabel}
      updatedAt="2026-06-24T17:30:00.000Z"
    />
  )
  return container.textContent ?? ''
}

describe('ChecksPanel updated-at metadata', () => {
  it.each(['PR', 'MR'])(
    'renders a whitespace boundary between the %s updated label and timestamp',
    (reviewShortLabel) => {
      const text = renderMetadataText(reviewShortLabel)

      expect(text).toMatch(new RegExp(`${reviewShortLabel} updated\\s+\\S`))
      expect(text).not.toMatch(new RegExp(`${reviewShortLabel} updated\\S`))
    }
  )
})
