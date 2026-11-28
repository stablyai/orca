// Saving the setup's app key, and importing it by hand when Orca didn't pick it up.
import type React from 'react'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewGuard
} from '../../../native-chat/pane/ownership/native-chat-view-memory'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import type { GoogleSetupKeyCandidate } from '../../../../../../shared/rpc-contract/google-setup-params'
import { importGoogleApp, refreshGoogle } from '../google-connect-client'
import { googleKeyRefusalHeadline } from '../google-copy'
import { useGoogleClientFile } from '../use-google-client-file'
import { answerGoogleSetup, importGoogleSetupKeyOnHost } from './google-setup-run-store'

export async function saveGoogleSetupKey(bot: BotRef, text: string): Promise<void> {
  await importGoogleApp(botTarget(bot), text).catch((error: unknown) => {
    throw new Error(
      googleKeyRefusalHeadline(error instanceof Error ? error.message : String(error))
    )
  })
  await answerGoogleSetup(bot, 'step', ['done', 'client'])
}

const NO_CANDIDATES: readonly GoogleSetupKeyCandidate[] = []

/** For a key Orca didn't pick up (saved elsewhere, or the download went missed): import it by hand. */
export function GoogleSetupKeyImport({ bot }: { bot: BotRef }): React.JSX.Element {
  const t = useTranslate()
  // Files on the bot's host that it can't tell apart: the owner picks one. Kept with the chat tab, so a host reply
  // landing while the chat is switched away still offers them on return.
  const [candidates, setCandidates] = useNativeChatViewGuard<readonly GoogleSetupKeyCandidate[]>(
    `google-key-candidates:${bot.id}`,
    NO_CANDIDATES,
    KEPT_PROMPT_VIEWS
  )
  const fromHost = async (picked?: GoogleSetupKeyCandidate): Promise<boolean> => {
    const reply = await importGoogleSetupKeyOnHost(bot, picked)
    setCandidates(
      reply && !reply.found && reply.candidates.length > 0 ? reply.candidates : NO_CANDIDATES
    )
    if (reply?.found) {
      await refreshGoogle(botTarget(bot))
    }
    return reply !== null && (reply.found || reply.candidates.length > 0)
  }
  // A bot on another host: its browser's download is there, so that host looks first.
  const file = useGoogleClientFile((text) => saveGoogleSetupKey(bot, text), {
    tryHost: () => fromHost(),
    memoryKey: `key-import:${bot.id}`
  })
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      {t('bots.googleSetup.keyMissed', 'Downloaded the key and Orca didn’t pick it up?')}{' '}
      <Button
        variant="link"
        size="inlineText"
        disabled={file.busy}
        onClick={() => void file.pick()}
      >
        {t('bots.google.importSetupFile', 'Import file')}
      </Button>
      {candidates.length > 0 ? (
        <div className="mt-1 flex flex-col items-start">
          {t('bots.googleSetup.pickHostKey', 'Pick the key file to import:')}
          {candidates.map((candidate) => (
            <Button
              key={candidate.id}
              variant="link"
              size="inlineText"
              disabled={file.busy}
              onClick={() =>
                void fromHost(candidate).catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }
            >
              {candidate.name}
            </Button>
          ))}
          <Button
            variant="link"
            size="inlineText"
            disabled={file.busy}
            onClick={() => void file.pickHere()}
          >
            {t('bots.googleSetup.pickKeyHere', 'Choose a file on this computer')}
          </Button>
        </div>
      ) : null}
      {file.error ? (
        <p role="alert" className="mt-1 text-destructive">
          {file.error}
        </p>
      ) : null}
    </div>
  )
}
