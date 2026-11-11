import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ToknUploadPreview as ToknUploadPreviewData } from '../../../../shared/tokn-sync-status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Button } from '../ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'

// Module-level because React Compiler cannot compile try/finally without catch.
async function fetchPreview(
  setLoading: (loading: boolean) => void,
  isMounted: () => boolean
): Promise<ToknUploadPreviewData> {
  setLoading(true)
  try {
    return await window.api.tokn.previewUpload()
  } finally {
    if (isMounted()) {
      setLoading(false)
    }
  }
}

/** Shows the exact request body, so what leaves the machine can be checked before and after connecting. */
export function ToknUploadPreview(): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<ToknUploadPreviewData | null>(null)
  const [loading, setLoading] = useState(false)

  const handleOpenChange = async (nextOpen: boolean): Promise<void> => {
    setOpen(nextOpen)
    if (!nextOpen) {
      return
    }
    const next = await fetchPreview(setLoading, () => mountedRef.current)
    if (mountedRef.current) {
      setPreview(next)
    }
  }

  const rows = preview?.body.rows ?? []
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => void handleOpenChange(next)}
      className="w-full"
    >
      <CollapsibleTrigger asChild>
        <Button variant="link" size="inline">
          <ChevronRight
            className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
          {t('auto.components.stats.ToknUploadPreview.trigger', 'Preview upload')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="space-y-2">
          {loading && !preview ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('auto.components.stats.ToknUploadPreview.loading', 'Reading tracked usage')}
            </p>
          ) : preview ? (
            <>
              <p className="text-xs text-muted-foreground">
                {rows.length === 0
                  ? t(
                      'auto.components.stats.ToknUploadPreview.empty',
                      'No tracked usage to upload yet.'
                    )
                  : t(
                      'auto.components.stats.ToknUploadPreview.summary',
                      '{{count}} rows from {{first}} to {{last}}, sent to {{endpoint}}',
                      {
                        count: rows.length,
                        first: rows[0]?.day ?? '',
                        last: rows.at(-1)?.day ?? '',
                        endpoint: preview.endpoint,
                        defaultValue_one:
                          '{{count}} row from {{first}} to {{last}}, sent to {{endpoint}}'
                      }
                    )}
              </p>
              <pre className="scrollbar-sleek max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-2xs leading-relaxed text-foreground">
                {JSON.stringify(preview.body, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
