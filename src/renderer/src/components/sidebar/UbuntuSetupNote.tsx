// PARITY-DNF: an imported setup from Conductor (Amazon Linux, dnf). Says what changed for Orca's
// Ubuntu sandboxes, and lists the lines that still use dnf so the person can check them.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { UbuntuNote } from '../../../../shared/workspace-setup/setup-script-imports'

export function UbuntuSetupNote({ note }: { note: UbuntuNote }): React.JSX.Element {
  const t = useTranslate()
  const check = note.checkLines.length > 0
  const translated = note.translated > 0
  return (
    <section className="min-w-0 text-xs text-muted-foreground" data-ubuntu-setup-note>
      <h3 className="mb-0.5 font-medium text-foreground">
        {t('setupScriptImport.ubuntuNote.title', 'Written for dnf')}
      </h3>
      <p className="mb-1.5">
        {translated && check
          ? t(
              'setupScriptImport.ubuntuNote.mixed',
              'Orca’s sandboxes run Ubuntu, so this script’s dnf install lines now use apt-get. These lines still use dnf. Check them before saving:'
            )
          : check
            ? t(
                'setupScriptImport.ubuntuNote.check',
                'Orca’s sandboxes run Ubuntu, and these lines still use dnf. Check them before saving:'
              )
            : t(
                'setupScriptImport.ubuntuNote.translated',
                'Orca’s sandboxes run Ubuntu, so this script’s dnf install lines now use apt-get.'
              )}
      </p>
      {check ? (
        <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto scrollbar-sleek">
          {note.checkLines.map((line) => (
            <li key={line} className="max-w-full">
              {/* Wrapped, never cut off: the person has to read the whole line. */}
              <code className="block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all whitespace-pre-wrap text-foreground">
                {line}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
