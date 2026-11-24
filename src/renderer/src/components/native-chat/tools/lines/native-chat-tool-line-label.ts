import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatToolRowVerb } from '../../../../../../shared/native-chat/tools/native-chat-tool-line-label'

/** Keep literal translation call sites for extraction; parity tests match the shared mobile record. */
export function nativeChatToolRowVerb(
  verb: NativeChatToolRowVerb,
  t: Translate = translate
): string {
  switch (verb) {
    case 'running':
      return t('components.native-chat.tool.row.running', 'Running')
    case 'ran':
      return t('components.native-chat.tool.row.ran', 'Ran')
    case 'reading':
      return t('components.native-chat.tool.row.reading', 'Reading')
    case 'read':
      return t('components.native-chat.tool.row.read', 'Read')
    case 'triedRead':
      return t('components.native-chat.tool.row.triedRead', 'Tried to read')
    case 'editing':
      return t('components.native-chat.tool.row.editing', 'Editing')
    case 'edited':
      return t('components.native-chat.tool.row.edited', 'Edited')
    case 'triedEdit':
      return t('components.native-chat.tool.row.triedEdit', 'Tried to edit')
    case 'added':
      return t('components.native-chat.tool.row.added', 'Added')
    case 'deleted':
      return t('components.native-chat.tool.row.deleted', 'Deleted')
    case 'renamed':
      return t('components.native-chat.tool.row.renamed', 'Renamed')
    case 'subagent':
      return t('components.native-chat.tool.row.subagent', 'Subagent')
    case 'searching':
      return t('components.native-chat.tool.row.searching', 'Searching')
    case 'searched':
      return t('components.native-chat.tool.row.searched', 'Searched')
    case 'triedSearch':
      return t('components.native-chat.tool.row.triedSearch', 'Tried to search')
    case 'listing':
      return t('components.native-chat.tool.row.listing', 'Listing')
    case 'listed':
      return t('components.native-chat.tool.row.listed', 'Listed')
    case 'triedList':
      return t('components.native-chat.tool.row.triedList', 'Tried to list')
    case 'fetching':
      return t('components.native-chat.tool.row.fetching', 'Fetching')
    case 'fetched':
      return t('components.native-chat.tool.row.fetched', 'Fetched')
    case 'triedFetch':
      return t('components.native-chat.tool.row.triedFetch', 'Tried to fetch')
    case 'searchingWeb':
      return t('components.native-chat.tool.row.searchingWeb', 'Searching the web')
    case 'searchedWeb':
      return t('components.native-chat.tool.row.searchedWeb', 'Searched the web')
    case 'triedSearchWeb':
      return t('components.native-chat.tool.row.triedSearchWeb', 'Tried to search the web')
  }
}
