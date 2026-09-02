import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

export function LargeDiffLoadPrompt({
  onLoad,
  sizeUnknown = false
}: {
  onLoad: () => void
  // Deferred rows split two ways: over the changed-line limit, or never counted
  // at all. Claiming "large" for an uncounted 4 KB binary would be false.
  sizeUnknown?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="large-diff-load-prompt"
      className="flex h-full min-h-[120px] items-center justify-center border border-border bg-muted/10 px-4 py-6 text-muted-foreground"
    >
      <div className="space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {sizeUnknown
            ? translate(
                'auto.components.editor.LargeDiffLoadPrompt.c3d9f4a712',
                "This diff's size isn't known yet, so it loads on request."
              )
            : translate(
                'auto.components.editor.LargeDiffLoadPrompt.a0af0198aa',
                'Large diffs are not rendered by default.'
              )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            onLoad()
          }}
        >
          {translate('auto.components.editor.LargeDiffLoadPrompt.f7fa7a40d0', 'Load diff')}
        </Button>
      </div>
    </div>
  )
}
