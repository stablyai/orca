// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import {
  EDITOR_READ_OVERRIDE_CEILING_BYTES,
  EDITOR_TEXT_READ_LIMIT_BYTES,
  formatFileTooLargeMessage
} from '../../../../shared/editor-file-read-limit'

const tooLarge = `Error invoking remote method 'fs:readFile': Error: ${formatFileTooLargeMessage({
  byteLength: 53_477_376,
  limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.local,
  scope: 'local'
})}`

describe('EditorFileLoadErrorView', () => {
  afterEach(cleanup)

  it('degrades an oversized file to the explanatory fallback', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={tooLarge}
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
      />
    )

    expect(html).toContain('data-testid="large-file-fallback"')
    expect(html).toContain('/repo/generated.json')
    // Retry re-runs the same size check, so offering it is a guaranteed dead end.
    expect(html).not.toContain('Retry')
  })

  // The runtime host reads a bounded prefix, so it reports the budget but never
  // the file's size. Showing the prefix length as "File size" told a user with a
  // 4GB log that the file was 0.5MB.
  it('omits the size row when the host never observed one', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={formatFileTooLargeMessage({ limitBytes: 512 * 1024, scope: 'runtime' })}
        filePath="/remote/repo/huge.log"
        onRetry={vi.fn()}
      />
    )

    expect(html).toContain('data-testid="large-file-fallback"')
    expect(html).toContain('512.0 KB')
    expect(html).not.toContain('File size')
  })

  it('degrades the bare file_too_large protocol token instead of printing it', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message="file_too_large"
        filePath="/remote/repo/huge.log"
        onRetry={vi.fn()}
      />
    )

    expect(html).toContain('data-testid="large-file-fallback"')
    expect(html).not.toContain('file_too_large')
    expect(html).not.toContain('Retry')
    // Nothing numeric was observed, so neither row may claim a number.
    expect(html).not.toContain('File size')
    expect(html).not.toContain('Read limit')
  })

  // The size cap is a confirmation, not a verdict: a local read has no transport
  // to protect, so the user may overrule it. Without an action the panel is a
  // dead end and the file is permanently unopenable.
  it('offers an override for a local refusal and re-reads with the cap lifted', () => {
    const onOpenAnyway = vi.fn()
    render(
      <EditorFileLoadErrorView
        message={tooLarge}
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
        onOpenAnyway={onOpenAnyway}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Anyway' }))

    expect(onOpenAnyway).toHaveBeenCalledTimes(1)
  })

  // The SSH budget guards a transport the client cannot overrule, so promising an
  // override there would be a button that silently refuses again.
  it('withholds the override when the refusing transport cannot honour it', () => {
    for (const scope of ['ssh', 'runtime'] as const) {
      const html = renderToStaticMarkup(
        <EditorFileLoadErrorView
          message={formatFileTooLargeMessage({
            byteLength: 13_002_342,
            limitBytes: 10 * 1024 * 1024,
            scope
          })}
          filePath="/remote/repo/huge.log"
          onRetry={vi.fn()}
          onOpenAnyway={vi.fn()}
        />
      )
      expect(html).not.toContain('Open Anyway')
    }
  })

  // The refusal already names the limit that stopped it. When that limit is the
  // ceiling itself, the override has nothing left to lift and the button would
  // only re-run the same refusal.
  it('withholds the override once the refusing limit is the ceiling itself', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={formatFileTooLargeMessage({
          byteLength: EDITOR_READ_OVERRIDE_CEILING_BYTES + 1,
          limitBytes: EDITOR_READ_OVERRIDE_CEILING_BYTES,
          scope: 'local'
        })}
        filePath="/repo/enormous.log"
        onRetry={vi.fn()}
        onOpenAnyway={vi.fn()}
      />
    )

    expect(html).toContain('data-testid="large-file-fallback"')
    expect(html).not.toContain('Open Anyway')
    // The copy must not promise the action the same render just withheld.
    expect(html).not.toContain('You can open it anyway')
    expect(html).toContain('largest size the editor can hold')
  })

  // The offer and the sentence that describes it are one decision.
  it('promises the override only where it is actually offered', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={tooLarge}
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
        onOpenAnyway={vi.fn()}
      />
    )

    expect(html).toContain('Open Anyway')
    expect(html).toContain('You can open it anyway')
  })

  // Nothing observed says the ceiling was reached, so the panel states the budget
  // and stops there rather than guessing why the caller withheld the action.
  it('claims neither the override nor the ceiling when the surface offers no action', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message={tooLarge}
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
      />
    )

    expect(html).toContain('largest budget Orca opens without asking')
    expect(html).not.toContain('You can open it anyway')
    expect(html).not.toContain('largest size the editor can hold')
  })

  // A bare protocol token names no transport, so nothing was observed that would
  // justify claiming the cap is overridable.
  it('withholds the override when no transport was reported', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message="file_too_large"
        filePath="/remote/repo/huge.log"
        onRetry={vi.fn()}
        onOpenAnyway={vi.fn()}
      />
    )

    expect(html).not.toContain('Open Anyway')
  })

  it('keeps the retryable error box for every other failure', () => {
    const html = renderToStaticMarkup(
      <EditorFileLoadErrorView
        message="EACCES: permission denied"
        filePath="/repo/generated.json"
        onRetry={vi.fn()}
      />
    )

    expect(html).not.toContain('data-testid="large-file-fallback"')
    expect(html).toContain('Retry')
  })
})
