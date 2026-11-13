// PARITY-DNF: an imported setup from Conductor (Amazon Linux, dnf). Says what changed for Orca's
// Ubuntu sandboxes, and lists the lines that still use dnf so the person can check them.
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { UbuntuNote } from '../../../../shared/workspace-setup/setup-script-imports'

export function UbuntuSetupNote({ note }: { note: UbuntuNote }): React.JSX.Element {
  const t = useTranslate()
  const check = note.checkLines.length > 0
  return (
    <section className="min-w-0 text-xs text-muted-foreground" data-ubuntu-setup-note>
      <h3 className="mb-0.5 font-medium text-foreground">
        {t('setupScriptImport.ubuntuNote.title', 'Uses dnf')}
      </h3>
      <p className="mb-1.5">
        {check
          ? t(
              'setupScriptImport.ubuntuNote.check',
              'This script uses dnf; Orca’s sandboxes run Ubuntu. Check these lines:'
            )
          : t(
              'setupScriptImport.ubuntuNote.translated',
              'This script used dnf; Orca’s sandboxes run Ubuntu, so its install lines now use apt-get.'
            )}
      </p>
      {check ? (
        <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto scrollbar-sleek">
          {note.checkLines.map((line) => (
            <li key={line} className="max-w-full">
              <code className="block truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                {line}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
