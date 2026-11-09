// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ArtifactPublishedLinkPanel } from './ArtifactPublishedLinkPanel'

const i18n = vi.hoisted(() => ({
  labels: new Map<string, string>()
}))

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (key: string, fallback: string) => i18n.labels.get(key) ?? fallback
}))

const updateKey = 'auto.components.artifacts.ArtifactPublishedLinkPanel.update'

// Shipped copy that is longer than the English "Update shared content" (21).
const longUpdateLabels = [
  'Обновить опубликованное содержимое',
  'Actualizar el contenido compartido'
] as const

describe('ArtifactPublishedLinkPanel', () => {
  afterEach(() => {
    i18n.labels.clear()
    cleanup()
  })

  it('keeps a long update label inside the fixed share popover', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()

    for (const label of longUpdateLabels) {
      i18n.labels.set(updateKey, label)
      const { unmount } = render(
        <TooltipProvider>
          <div className="w-80 p-4">
            <ArtifactPublishedLinkPanel
              shareUrl="https://example.com/artifact"
              publishing={false}
              sharingEnabled
              onUpdate={onUpdate}
            />
          </div>
        </TooltipProvider>
      )

      const button = screen.getByRole('button', { name: label })
      const classes = button.className.split(/\s+/).filter(Boolean)
      // happy-dom does not measure glyphs. The popover is w-80 and the shared
      // button is nowrap at a fixed height, so the merged utilities are what
      // keep the label and outline inside that width.
      expect(classes).not.toContain('whitespace-nowrap')
      expect(classes).not.toContain('h-8')
      expect(classes).toEqual(
        expect.arrayContaining(['h-auto', 'min-h-8', 'max-w-full', 'w-full', 'whitespace-normal'])
      )
      expect(button).toHaveAccessibleName(label)

      await user.click(button)
      unmount()
    }

    expect(onUpdate).toHaveBeenCalledTimes(longUpdateLabels.length)
  })
})
